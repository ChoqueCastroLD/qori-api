import { db } from "../db";
import { applyLedger } from "./wallet";
import { hmacSha256Hex, sha256Hex } from "../fair";
import { generateShow, type GameType } from "../show";
import { sendEmail, winnerEmail } from "./email";

/** Fetch the latest drand round (public verifiable randomness beacon). */
export async function fetchDrandLatest(): Promise<{ round: number; randomness: string }> {
  const res = await fetch("https://api.drand.sh/public/latest");
  if (!res.ok) throw new Error("drand_unreachable");
  const j = (await res.json()) as { round: number; randomness: string };
  return { round: j.round, randomness: j.randomness };
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
  const tickets = await db.ticket.findMany({ where: { raffleId }, orderBy: { number: "asc" } });
  if (!raffle || tickets.length === 0) {
    await db.raffle.update({ where: { id: raffleId }, data: { status: "OPEN" } });
    return null;
  }

  const drand = await fetchDrandLatest();
  const ticketsRoot = await computeTicketsRoot(raffleId);
  const publicEntropy = `${drand.round}:${drand.randomness}:${ticketsRoot}`;
  const digest = await hmacSha256Hex(raffle.serverSeed!, publicEntropy);

  const show = generateShow({
    digest,
    ticketCount: tickets.length,
    winnersCount: raffle.winnersCount,
    games: (raffle.games as GameType[]) ?? ["ELIMINATION"],
    finale: (raffle.finale as GameType) ?? null,
  });
  const winnerTickets = show.winners.map((idx) => tickets[idx]);

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
        data: { raffleId, ticketId: winnerTickets[i].id, userId: winnerTickets[i].ownerId, position: i + 1 },
      });
    }
    // startsAt = now → the live synchronized show begins immediately.
    await tx.drawShow.upsert({
      where: { raffleId },
      update: { stages: show as any, startsAt: new Date() },
      create: { raffleId, stages: show as any, startsAt: new Date(), endsAt: null },
    });
  });

  // Notify winners by email (non-blocking).
  for (const wt of winnerTickets) {
    if (!wt.ownerId) continue;
    const owner = await db.user.findUnique({ where: { id: wt.ownerId }, select: { email: true } });
    if (owner?.email) {
      const { subject, html } = winnerEmail(raffle.title, wt.number, raffle.slug);
      void sendEmail({ to: owner.email, subject, html }).catch(() => {});
    }
  }

  return {
    winners: winnerTickets.map((wt, i) => ({ position: i + 1, number: wt.number })),
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
