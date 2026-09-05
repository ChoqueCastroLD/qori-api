import { Elysia, t } from "elysia";
import { db } from "../db";
import { applyLedger, InsufficientFundsError } from "../lib/wallet";
import { withUser } from "./auth";
import { suertudoSet } from "../lib/suertudo";
import { publishSold } from "../lib/liveRaffles";
import type { User } from "@prisma/client";
import {
  generateCard, cardToCols, colsToCard, cardKey, colsKey, validateCols,
  progress, letterOf, type BingoCols,
} from "../lib/bingo";

function requireUser(user: User | null, set: any): user is User {
  if (!user) { set.status = 401; return false; }
  return true;
}

// Players can pick/edit/regenerate their cards until this long before the draw.
const EDIT_LOCK_MS = 5 * 60 * 1000;
function editWindowOpen(status: string, closesAt: Date | null): boolean {
  if (status !== "OPEN") return false;
  if (closesAt && Date.now() > closesAt.getTime() - EDIT_LOCK_MS) return false;
  return true;
}
function editableUntilOf(closesAt: Date | null): string | null {
  return closesAt ? new Date(closesAt.getTime() - EDIT_LOCK_MS).toISOString() : null;
}

/** Generate `count` cards whose 24-number sets are all new (vs `taken` + each
 *  other). Uniqueness is astronomically easy; the cap only guards against bugs. */
function freshCards(count: number, taken: Set<string>): { cols: BingoCols; key: string }[] {
  const out: { cols: BingoCols; key: string }[] = [];
  for (let i = 0; i < count; i++) {
    let key = "";
    let cols: BingoCols | null = null;
    for (let attempt = 0; attempt < 100; attempt++) {
      const card = generateCard(Math.random);
      const k = cardKey(card);
      if (!taken.has(k)) { key = k; cols = cardToCols(card); break; }
    }
    if (!cols) throw new Error("could_not_assign");
    taken.add(key);
    out.push({ cols, key });
  }
  return out;
}

export const bingo = new Elysia({ name: "bingo" })
  .use(withUser)

  // --- Buy bingo cards (spend lingotes). Cards are auto-assigned random +
  // unique immediately, so the buyer is playing right away; editing is optional
  // and separate. Mirrors the ticket buy: same caps, paidOnly gate, bonus,
  // referral reward. ---
  .post(
    "/raffles/:slug/bingo/buy",
    async ({ user, params, body, set }) => {
      if (!requireUser(user, set)) return { error: "unauthenticated" };
      const quantity = body.quantity;

      void db.user.update({ where: { id: user.id }, data: { buyAttempts: { increment: 1 } } }).catch(() => {});
      if (user.canBuy === false) { set.status = 403; return { error: "buy_disabled" }; }

      try {
        const result = await db.$transaction(async (tx) => {
          const raffle = await tx.raffle.findUnique({ where: { slug: params.slug } });
          if (!raffle || raffle.kind !== "BINGO") throw new Error("raffle_not_found");
          if (raffle.blocked) throw new Error("raffle_blocked");
          if (raffle.status !== "OPEN") throw new Error("raffle_not_open");
          if (raffle.closesAt && raffle.closesAt.getTime() <= Date.now()) throw new Error("raffle_not_open");
          await tx.raffle.update({ where: { id: raffle.id }, data: { updatedAt: new Date() } });

          const sold = await tx.bingoCard.count({ where: { raffleId: raffle.id } });
          if (sold + quantity > raffle.totalTickets) throw new Error("sold_out");

          if (raffle.maxTicketsPerUser) {
            const mine = await tx.bingoCard.count({ where: { raffleId: raffle.id, ownerId: user.id } });
            if (mine + quantity > raffle.maxTicketsPerUser) throw new Error("per_user_limit");
          }

          if (raffle.paidOnly) {
            const paid = await tx.topUp.count({ where: { userId: user.id, status: "PAID" } });
            if (paid === 0) throw new Error("requires_paid_user");
          }

          const cost = raffle.ticketPrice * quantity;
          await applyLedger(tx, {
            userId: user.id, amount: -cost, type: "TICKET_SPEND",
            refType: "raffle", refId: raffle.id, memo: `${quantity} cartón(es) de ${raffle.title}`,
          });

          const bonus = raffle.ticketPrice > 0 ? quantity : 0;
          const order = await tx.order.create({
            data: { raffleId: raffle.id, userId: user.id, quantity, costLingotes: cost, bonusLingotes: bonus },
          });

          // Unique random cards. Load existing keys + next seq under the row lock.
          const taken = new Set(
            (await tx.bingoCard.findMany({ where: { raffleId: raffle.id }, select: { key: true } })).map((c) => c.key),
          );
          const agg = await tx.bingoCard.aggregate({ where: { raffleId: raffle.id }, _max: { seq: true } });
          let seq = agg._max.seq ?? 0;
          const cards = freshCards(quantity, taken);
          await tx.bingoCard.createMany({
            data: cards.map((c) => ({
              raffleId: raffle.id, ownerId: user.id, orderId: order.id,
              seq: ++seq, cols: c.cols as any, key: c.key,
            })),
          });

          if (bonus > 0) {
            await applyLedger(tx, {
              userId: user.id, amount: bonus, type: "TICKET_BONUS",
              refType: "order", refId: order.id, memo: `Bono +${bonus} por compra`,
            });
          }

          const fresh = await tx.user.findUnique({ where: { id: user.id } });
          if (fresh?.referredById && !fresh.referralRewarded) {
            await applyLedger(tx, {
              userId: fresh.referredById, amount: 10, type: "REFERRAL",
              refType: "user", refId: user.id, memo: "Referido hizo su primera compra",
            });
            await tx.user.update({ where: { id: user.id }, data: { referralRewarded: true } });
          }

          return { orderId: order.id, slug: raffle.slug, sold: sold + quantity, total: raffle.totalTickets };
        });

        publishSold(result.slug, result.sold, result.total);
        return { ok: true, orderId: result.orderId };
      } catch (e: any) {
        if (e instanceof InsufficientFundsError) { set.status = 402; return { error: "insufficient_funds" }; }
        const known = ["raffle_not_found", "raffle_not_open", "raffle_blocked", "sold_out", "per_user_limit", "requires_paid_user", "could_not_assign"];
        if (known.includes(e?.message)) {
          set.status = e.message === "raffle_not_found" ? 404 : 422;
          return { error: e.message };
        }
        set.status = 500;
        return { error: "buy_failed" };
      }
    },
    { params: t.Object({ slug: t.String() }), body: t.Object({ quantity: t.Integer({ minimum: 1, maximum: 200 }) }) },
  )

  // --- Live bingo state (public; includes `me` when signed in). Balls reveal
  // progressively off the synchronized timeline; future balls and winners stay
  // hidden until the reveal reaches them (suspense + no peeking). ---
  .get("/raffles/:slug/bingo", async ({ user, params, set }) => {
    const raffle = await db.raffle.findUnique({ where: { slug: params.slug }, include: { bingoGame: true } });
    if (!raffle || raffle.kind !== "BINGO") { set.status = 404; return { error: "not_found" }; }
    const isAdmin = user?.role === "ADMIN";
    if (raffle.status === "DRAFT" && !isAdmin) { set.status = 404; return { error: "not_found" }; }

    // Timeline: how many balls are visible right now.
    const game = raffle.bingoGame;
    let statusStr: "waiting" | "drawing" | "finished" = "waiting";
    let drawnBalls: number[] = [];
    let currentBall: { letter: string; number: number } | null = null;
    let nextBallInSec = 0;
    if (game) {
      const order = game.ballOrder;
      const interval = game.intervalSec * 1000;
      const elapsed = Date.now() - game.startsAt.getTime();
      const revealed = Math.max(0, Math.min(Math.floor(elapsed / interval), order.length));
      drawnBalls = order.slice(0, revealed);
      const lastN = revealed > 0 ? order[revealed - 1] : null;
      currentBall = lastN != null ? { letter: letterOf(lastN), number: lastN } : null;
      nextBallInSec = revealed >= order.length ? 0 : Math.max(0, Math.ceil((interval - (elapsed % interval)) / 1000));
      const finished = game.endsAt ? Date.now() >= game.endsAt.getTime() : revealed >= order.length;
      statusStr = finished ? "finished" : "drawing";
    } else if (raffle.status === "DRAWN") {
      statusStr = "finished";
    }
    const drawn = new Set(drawnBalls);

    // Participants: one row per user, using their best card's current progress.
    const cards = await db.bingoCard.findMany({
      where: { raffleId: raffle.id },
      select: { ownerId: true, cols: true, owner: { select: { id: true, nickname: true, username: true, avatarUrl: true } } },
    });
    const bestByUser = new Map<string, { owner: any; marks: number; letters: string[] }>();
    const cardCountByUser = new Map<string, number>();
    const cardsPerNumber: Record<number, number> = {};
    for (let n = 1; n <= 75; n++) cardsPerNumber[n] = 0;
    const lettersDone: Record<string, number> = { B: 0, I: 0, N: 0, G: 0, O: 0 };
    for (const c of cards) {
      const colsObj = c.cols as unknown as BingoCols;
      const p = progress(colsObj, drawn);
      const cur = bestByUser.get(c.ownerId);
      if (!cur || p.marks > cur.marks) bestByUser.set(c.ownerId, { owner: c.owner, marks: p.marks, letters: p.letters });
      cardCountByUser.set(c.ownerId, (cardCountByUser.get(c.ownerId) ?? 0) + 1);
      for (const L of p.letters) lettersDone[L]++;
      for (const arr of [colsObj.B, colsObj.I, colsObj.N, colsObj.G, colsObj.O]) for (const n of arr) cardsPerNumber[n]++;
    }
    const lucky = await suertudoSet([...bestByUser.keys(), user?.id]);
    const participants = [...bestByUser.values()]
      .map((e) => ({
        userId: e.owner.id,
        nickname: e.owner.nickname ?? e.owner.username ?? "Jugador",
        avatarUrl: e.owner.avatarUrl ?? null,
        suertudo: lucky.has(e.owner.id),
        bestLetters: e.letters,
        marks: e.marks,
        cards: cardCountByUser.get(e.owner.id) ?? 0,
      }))
      .sort((a, b) => b.marks - a.marks);

    // Me: my full cards (positions) so the HUD can render + mark them. When the
    // game is over, include MY win (with its private claim code) if I won.
    let me: any = null;
    if (user) {
      const myCards = await db.bingoCard.findMany({
        where: { raffleId: raffle.id, ownerId: user.id },
        orderBy: { seq: "asc" },
        select: { id: true, seq: true, cols: true },
      });
      const myWin = statusStr === "finished"
        ? await db.bingoWin.findFirst({ where: { raffleId: raffle.id, userId: user.id }, select: { shareUsd: true, claimCode: true, prizeStatus: true } })
        : null;
      me = {
        userId: user.id,
        nickname: user.nickname ?? user.username ?? "Tú",
        avatarUrl: user.avatarUrl ?? null,
        suertudo: lucky.has(user.id),
        cards: myCards.map((c) => ({ id: c.id, seq: c.seq, ...colsToCard(c.cols as unknown as BingoCols) })),
        activeCardIndex: 0,
        win: myWin ? { shareUsd: myWin.shareUsd / 100, claimCode: myWin.claimCode, prizeStatus: myWin.prizeStatus } : null,
      };
    }

    // Winners only once the reveal is over (keeps the ending a surprise).
    let winners: { nickname: string; avatarUrl: string | null; shareUsd: number; cards: number }[] | undefined;
    if (statusStr === "finished") {
      const wins = await db.bingoWin.findMany({
        where: { raffleId: raffle.id }, orderBy: { position: "asc" },
        include: { user: { select: { nickname: true, username: true, avatarUrl: true } } },
      });
      winners = wins.map((w) => ({
        nickname: w.user?.nickname ?? w.user?.username ?? "Ganador",
        avatarUrl: w.user?.avatarUrl ?? null,
        shareUsd: w.shareUsd / 100, // cents -> USD (frontend shows dollars)
        cards: w.userId ? cardCountByUser.get(w.userId) ?? 1 : 1,
      }));
    }

    return {
      slug: raffle.slug,
      status: statusStr,
      drawnBalls,
      currentBall,
      nextBallInSec,
      prize: {
        title: raffle.title,
        description: raffle.description,
        valueUsd: raffle.prizeValue / 100,
        imageUrl: raffle.images?.[0] ?? "",
      },
      meta: {
        ticketPrice: raffle.ticketPrice,
        totalCards: raffle.totalTickets,
        soldCards: cards.length,
        maxPerUser: raffle.maxTicketsPerUser,
        paidOnly: raffle.paidOnly,
        playersCount: bestByUser.size,
        closesAt: raffle.closesAt,
        startsAt: game?.startsAt ?? null,
        intervalSec: game?.intervalSec ?? 18,
      },
      fairness: {
        commitment: raffle.commitment,
        serverSeed: raffle.status === "DRAWN" ? raffle.serverSeed : null,
        drandRound: raffle.drandRound != null ? raffle.drandRound.toString() : null,
        drandValue: raffle.drandValue ?? null,
        digest: raffle.drawDigest ?? null,
      },
      participants,
      lettersDone,
      totalCards: cards.length,
      cardsPerNumber,
      viewers: bestByUser.size,
      me,
      winners,
    };
  })

  // --- My cards in a raffle (full positions + win state). ---
  .get("/raffles/:slug/bingo/cards", async ({ user, params, set }) => {
    if (!requireUser(user, set)) return { error: "unauthenticated" };
    const raffle = await db.raffle.findUnique({ where: { slug: params.slug }, select: { id: true, status: true, closesAt: true } });
    if (!raffle) { set.status = 404; return { error: "not_found" }; }
    const myCards = await db.bingoCard.findMany({
      where: { raffleId: raffle.id, ownerId: user.id },
      orderBy: { seq: "asc" },
      include: { win: { select: { shareUsd: true, position: true, claimCode: true, prizeStatus: true } } },
    });
    // Per-number popularity across ALL cards, so the picker can show how many
    // cartillas already hold each number.
    const all = await db.bingoCard.findMany({ where: { raffleId: raffle.id }, select: { cols: true } });
    const cardsPerNumber: Record<number, number> = {};
    for (let n = 1; n <= 75; n++) cardsPerNumber[n] = 0;
    for (const c of all) {
      const cols = c.cols as unknown as BingoCols;
      for (const arr of [cols.B, cols.I, cols.N, cols.G, cols.O]) for (const n of arr) cardsPerNumber[n]++;
    }
    return {
      editable: editWindowOpen(raffle.status, raffle.closesAt),
      editableUntil: editableUntilOf(raffle.closesAt),
      totalCards: all.length,
      cardsPerNumber,
      cards: myCards.map((c) => ({ id: c.id, seq: c.seq, ...colsToCard(c.cols as unknown as BingoCols), win: c.win ?? null })),
    };
  })

  // --- Edit a card within the classic constraints (column ranges, no repeats,
  // center free) + uniqueness. Only the owner, only while the raffle is OPEN. ---
  .patch(
    "/bingo/cards/:id",
    async ({ user, params, body, set }) => {
      if (!requireUser(user, set)) return { error: "unauthenticated" };
      const card = await db.bingoCard.findUnique({ where: { id: params.id }, include: { raffle: { select: { id: true, status: true, closesAt: true } } } });
      if (!card || card.ownerId !== user.id) { set.status = 404; return { error: "not_found" }; }
      if (!editWindowOpen(card.raffle.status, card.raffle.closesAt)) { set.status = 422; return { error: "edit_closed" }; }
      const cols = body.cols as BingoCols;
      if (!validateCols(cols)) { set.status = 422; return { error: "invalid_card" }; }
      const key = colsKey(cols);
      if (key !== card.key) {
        const dup = await db.bingoCard.findUnique({ where: { raffleId_key: { raffleId: card.raffleId, key } }, select: { id: true } });
        if (dup && dup.id !== card.id) { set.status = 409; return { error: "duplicate_card" }; }
      }
      try {
        await db.bingoCard.update({ where: { id: card.id }, data: { cols: cols as any, key } });
      } catch { set.status = 409; return { error: "duplicate_card" }; }
      return { ok: true, id: card.id, seq: card.seq, ...colsToCard(cols) };
    },
    { params: t.Object({ id: t.String() }), body: t.Object({ cols: t.Any() }) },
  )

  // --- Regenerate a card at random (unique). Owner + OPEN only. ---
  .post("/bingo/cards/:id/regenerate", async ({ user, params, set }) => {
    if (!requireUser(user, set)) return { error: "unauthenticated" };
    const card = await db.bingoCard.findUnique({ where: { id: params.id }, include: { raffle: { select: { status: true, closesAt: true } } } });
    if (!card || card.ownerId !== user.id) { set.status = 404; return { error: "not_found" }; }
    if (!editWindowOpen(card.raffle.status, card.raffle.closesAt)) { set.status = 422; return { error: "edit_closed" }; }
    const taken = new Set(
      (await db.bingoCard.findMany({ where: { raffleId: card.raffleId }, select: { id: true, key: true } }))
        .filter((c) => c.id !== card.id)
        .map((c) => c.key),
    );
    try {
      const [next] = freshCards(1, taken);
      await db.bingoCard.update({ where: { id: card.id }, data: { cols: next.cols as any, key: next.key } });
      return { ok: true, id: card.id, seq: card.seq, ...colsToCard(next.cols) };
    } catch { set.status = 409; return { error: "duplicate_card" }; }
  });
