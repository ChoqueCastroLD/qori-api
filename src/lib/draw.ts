import { db } from "../db";
import type { Raffle } from "@prisma/client";
import { applyLedger } from "./wallet";
import { hmacSha256Hex, sha256Hex } from "../fair";
import { generateShow, generateShowV2, type GameType } from "../show";
import { publishDrawStart } from "./liveRaffles";
import { newClaimCode, newBingoClaimCode } from "./claim";
import { ballOrder, findWinners, colsToCard, type BingoCols } from "./bingo";

const DRAND_BASE = "https://api.drand.sh";

/** Fetch the latest drand round (fallback only). */
export async function fetchDrandLatest(): Promise<{ round: number; randomness: string }> {
  const res = await fetch(`${DRAND_BASE}/public/latest`);
  if (!res.ok) throw new Error("drand_unreachable");
  const j = (await res.json()) as { round: number; randomness: string };
  return { round: j.round, randomness: j.randomness };
}

// drand chain params (genesis + period), cached. Used to map a time → round.
let drandInfoCache: { genesis: number; period: number } | null = null;
async function drandInfo(): Promise<{ genesis: number; period: number }> {
  if (drandInfoCache) return drandInfoCache;
  const res = await fetch(`${DRAND_BASE}/info`);
  const j = (await res.json()) as { genesis_time: number; period: number };
  drandInfoCache = { genesis: j.genesis_time, period: j.period };
  return drandInfoCache;
}
function roundAt(timeSec: number, genesis: number, period: number): number {
  if (timeSec <= genesis) return 1;
  return Math.floor((timeSec - genesis) / period) + 1;
}
async function fetchDrandRound(round: number): Promise<{ round: number; randomness: string } | null> {
  const res = await fetch(`${DRAND_BASE}/public/${round}`);
  if (!res.ok) return null; // not published yet
  const j = (await res.json()) as { round: number; randomness: string };
  return { round: j.round, randomness: j.randomness };
}

/**
 * The drand round fixed by the raffle's close time. The round number is fully
 * determined by `closesAt` (public), and its VALUE stays unpredictable until
 * that time - so neither the operator nor anyone else can grind or foresee it.
 * Returns null if that round hasn't been published yet (draw not ready).
 */
export async function drandForCloseTime(closesAtMs: number): Promise<{ round: number; randomness: string } | null> {
  const info = await drandInfo();
  const round = roundAt(Math.floor(closesAtMs / 1000), info.genesis, info.period);
  return fetchDrandRound(round);
}

/** Deterministic root binding the exact participant set into the entropy. */
export async function computeTicketsRoot(raffleId: string): Promise<string> {
  const tickets = await db.ticket.findMany({
    where: { raffleId },
    orderBy: { number: "asc" },
    select: { number: true, ownerId: true },
  });
  const canonical = tickets.map((t) => `${t.number}:${t.ownerId ?? ""}`).join("|");
  return sha256Hex(canonical);
}

export interface DrawResult {
  winners: { position: number; number: number }[];
  publicEntropy: string;
  digest: string;
  drandRound: number;
}

/**
 * Execute the draw: fetch drand, compute the show, persist winners + reveal the
 * seed. Atomically claims the raffle (OPEN/CLOSED → DRAWN) so it can't run twice
 * even if the admin and the scheduler race. Returns null if already claimed.
 */
export async function executeDraw(raffleId: string): Promise<DrawResult | null> {
  // Claim: only proceed if still open/closed.
  const claim = await db.raffle.updateMany({
    where: { id: raffleId, status: { in: ["OPEN", "CLOSED"] } },
    data: { status: "DRAWING" },
  });
  if (claim.count === 0) return null;

  const raffle = await db.raffle.findUnique({ where: { id: raffleId } });
  if (!raffle) {
    await db.raffle.update({ where: { id: raffleId }, data: { status: "OPEN" } }).catch(() => {});
    return null;
  }

  // Bingo raffles use their own card-based draw (ball order + full-card winners).
  if (raffle.kind === "BINGO") return executeBingoDraw(raffle);

  const tickets = await db.ticket.findMany({ where: { raffleId }, orderBy: { number: "asc" } });
  if (tickets.length === 0) {
    await db.raffle.update({ where: { id: raffleId }, data: { status: "OPEN" } });
    return null;
  }

  // Use the drand round fixed by the close time (no operator grinding). If that
  // round isn't published yet, put the raffle back to OPEN and retry next tick.
  const drand = raffle.closesAt
    ? await drandForCloseTime(raffle.closesAt.getTime())
    : await fetchDrandLatest();
  if (!drand) {
    await db.raffle.update({ where: { id: raffleId }, data: { status: "OPEN" } });
    return null;
  }
  const ticketsRoot = await computeTicketsRoot(raffleId);
  const publicEntropy = `${drand.round}:${drand.randomness}:${ticketsRoot}`;
  const digest = await hmacSha256Hex(raffle.serverSeed!, publicEntropy);

  const showOpts = {
    digest,
    ticketCount: tickets.length,
    winnersCount: raffle.winnersCount,
    games: (raffle.games as GameType[]) ?? ["ELIMINATION"],
    finale: (raffle.finale as GameType) ?? null,
  };
  // Version 2 = per-game deterministic sims (winners = survivors); legacy = v1.
  const useV2 = raffle.showVersion === 2;
  const show = useV2 ? generateShowV2(showOpts) : generateShow(showOpts);
  const winnerTickets = show.winners.map((idx) => tickets[idx]);
  // A unique prize-claim code per winner, generated up front.
  const claimCodes: string[] = [];
  for (let i = 0; i < winnerTickets.length; i++) claimCodes.push(await newClaimCode());

  await db.$transaction(async (tx) => {
    await tx.raffle.update({
      where: { id: raffleId },
      data: {
        status: "DRAWN",
        drandRound: BigInt(drand.round),
        drandValue: drand.randomness,
        ticketsRoot,
        drawDigest: digest,
        drawnAt: new Date(),
      },
    });
    for (let i = 0; i < winnerTickets.length; i++) {
      await tx.winner.create({
        data: { raffleId, ticketId: winnerTickets[i].id, userId: winnerTickets[i].ownerId, position: i + 1, claimCode: claimCodes[i] },
      });
    }
    // startsAt = now → the live synchronized show begins immediately.
    await tx.drawShow.upsert({
      where: { raffleId },
      update: { stages: show as any, startsAt: new Date() },
      create: { raffleId, stages: show as any, startsAt: new Date(), endsAt: null },
    });
  });

  // Push everyone watching into the live show the instant it's ready.
  publishDrawStart(raffle.slug);

  // No email at draw time: it lands ~2 min late (useless). Participants are
  // warned ~5 min before by the scheduler (startingSoonEmail); results emails
  // go out when the show ends (sendResults).

  return {
    winners: winnerTickets.map((wt, i) => ({ position: i + 1, number: wt.number })),
    publicEntropy,
    digest,
    drandRound: drand.round,
  };
}

/** Deterministic root binding the exact card set into the entropy (bingo). */
async function computeCardsRoot(raffleId: string): Promise<string> {
  const cards = await db.bingoCard.findMany({
    where: { raffleId },
    orderBy: { seq: "asc" },
    select: { seq: true, key: true, ownerId: true },
  });
  const canonical = cards.map((c) => `${c.seq}:${c.key}:${c.ownerId}`).join("|");
  return sha256Hex(canonical);
}

/**
 * Bingo draw: derive the 75-ball order from the provably-fair digest, find the
 * card(s) that complete first (full card), split the prize's USD value on a
 * same-ball tie, and lay down the synchronized ball timeline. `raffle` is
 * already claimed to DRAWING by executeDraw. Reverts to OPEN if not ready.
 */
async function executeBingoDraw(raffle: Raffle): Promise<DrawResult | null> {
  const raffleId = raffle.id;
  const cards = await db.bingoCard.findMany({ where: { raffleId }, orderBy: { seq: "asc" } });
  if (cards.length === 0) {
    await db.raffle.update({ where: { id: raffleId }, data: { status: "OPEN" } });
    return null;
  }

  const drand = raffle.closesAt
    ? await drandForCloseTime(raffle.closesAt.getTime())
    : await fetchDrandLatest();
  if (!drand) {
    await db.raffle.update({ where: { id: raffleId }, data: { status: "OPEN" } });
    return null;
  }

  const cardsRoot = await computeCardsRoot(raffleId);
  const publicEntropy = `${drand.round}:${drand.randomness}:${cardsRoot}`;
  const digest = await hmacSha256Hex(raffle.serverSeed!, publicEntropy);
  const order = ballOrder(digest);

  const { winners, winningBallIndex } = findWinners(
    cards.map((c) => ({ card: colsToCard(c.cols as unknown as BingoCols), id: c.id, ownerId: c.ownerId, seq: c.seq })),
    order,
  );

  // Split the prize's USD value equally on a tie; the odd cents go to the first
  // winners so the shares always sum to exactly prizeValue.
  const n = winners.length;
  const base = Math.floor(raffle.prizeValue / n);
  const remainder = raffle.prizeValue - base * n;
  const shares = winners.map((_, i) => base + (i < remainder ? 1 : 0));

  const claimCodes: string[] = [];
  for (let i = 0; i < n; i++) claimCodes.push(await newBingoClaimCode());

  const startsAt = new Date();
  // The reveal runs until the winning ball is called.
  const endsAt = new Date(startsAt.getTime() + (winningBallIndex + 1) * 18 * 1000);

  await db.$transaction(async (tx) => {
    await tx.raffle.update({
      where: { id: raffleId },
      data: {
        status: "DRAWN",
        drandRound: BigInt(drand.round),
        drandValue: drand.randomness,
        ticketsRoot: cardsRoot,
        drawDigest: digest,
        drawnAt: new Date(),
      },
    });
    for (let i = 0; i < n; i++) {
      await tx.bingoWin.create({
        data: {
          raffleId,
          cardId: winners[i].id,
          userId: winners[i].ownerId,
          position: i + 1,
          shareUsd: shares[i],
          claimCode: claimCodes[i],
        },
      });
    }
    await tx.bingoGame.upsert({
      where: { raffleId },
      update: { ballOrder: order, intervalSec: 18, startsAt, endsAt },
      create: { raffleId, ballOrder: order, intervalSec: 18, startsAt, endsAt },
    });
  });

  publishDrawStart(raffle.slug);

  return {
    winners: winners.map((w, i) => ({ position: i + 1, number: w.seq })),
    publicEntropy,
    digest,
    drandRound: drand.round,
  };
}

/** Cancel a raffle and refund all spent lingotes. */
export async function refundRaffle(raffleId: string): Promise<number> {
  const raffle = await db.raffle.findUnique({ where: { id: raffleId } });
  if (!raffle) return 0;
  const orders = await db.order.findMany({ where: { raffleId, status: "CONFIRMED" } });
  await db.$transaction(async (tx) => {
    for (const o of orders) {
      await applyLedger(tx, {
        userId: o.userId, amount: o.costLingotes, type: "REFUND",
        refType: "order", refId: o.id, memo: `Reembolso: ${raffle.title} cancelado`,
      });
      await tx.order.update({ where: { id: o.id }, data: { status: "REFUNDED" } });
    }
    await tx.raffle.update({ where: { id: raffleId }, data: { status: "CANCELLED" } });
  });
  return orders.length;
}
