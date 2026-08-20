import { Elysia, t } from "elysia";
import { db } from "../db";
import { applyLedger } from "../lib/wallet";
import { createCommitment, hmacSha256Hex, sha256Hex } from "../fair";
import { generateShow, type GameType } from "../show";
import { withUser } from "./auth";

const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "";

/** Fetch the latest drand round (public verifiable randomness beacon). */
async function fetchDrandLatest(): Promise<{ round: number; randomness: string }> {
  const res = await fetch("https://api.drand.sh/public/latest");
  if (!res.ok) throw new Error("drand_unreachable");
  const j = (await res.json()) as { round: number; randomness: string };
  return { round: j.round, randomness: j.randomness };
}

/** Deterministic root binding the exact participant set into the entropy. */
async function computeTicketsRoot(raffleId: string): Promise<string> {
  const tickets = await db.ticket.findMany({
    where: { raffleId },
    orderBy: { number: "asc" },
    select: { number: true, ownerId: true },
  });
  const canonical = tickets.map((t) => `${t.number}:${t.ownerId ?? ""}`).join("|");
  return sha256Hex(canonical);
}

export const admin = new Elysia({ name: "admin", prefix: "/admin" })
  .use(withUser)
  .guard({
    beforeHandle({ headers, set, user }: any) {
      const byToken = ADMIN_TOKEN && headers["authorization"] === `Bearer ${ADMIN_TOKEN}`;
      const bySession = user?.role === "ADMIN";
      if (!byToken && !bySession) {
        set.status = 401;
        return { error: "unauthorized" };
      }
    },
  })
  // List every raffle (incl. drafts).
  .get("/raffles", async () => {
    const raffles = await db.raffle.findMany({
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { tickets: true, orders: true } } },
    });
    return raffles;
  })

  // Create a raffle (auto-commitment, opens immediately).
  .post(
    "/raffles",
    async ({ body }) => {
      const { serverSeed, commitment } = await createCommitment();
      const raffle = await db.raffle.create({
        data: {
          slug: body.slug,
          title: body.title,
          description: body.description,
          images: body.images ?? [],
          prizeValue: body.prizeValue,
          ticketPrice: body.ticketPrice,
          totalTickets: body.totalTickets,
          minTickets: body.minTickets ?? 1,
          maxTicketsPerUser: body.maxTicketsPerUser ?? null,
          winnersCount: body.winnersCount ?? 1,
          games: (body.games ?? ["ELIMINATION"]) as any,
          finale: (body.finale ?? null) as any,
          entropySource: "drand (round programada a la hora del sorteo) + raíz de boletos",
          commitment,
          serverSeed,
          status: (body.status ?? "OPEN") as any,
          opensAt: new Date(),
          closesAt: body.closesAt ? new Date(body.closesAt) : null,
        },
      });
      return { id: raffle.id, slug: raffle.slug, commitment };
    },
    {
      body: t.Object({
        slug: t.String(),
        title: t.String(),
        description: t.String(),
        images: t.Optional(t.Array(t.String())),
        prizeValue: t.Integer(),
        ticketPrice: t.Integer({ minimum: 0 }),
        totalTickets: t.Integer({ minimum: 1 }),
        minTickets: t.Optional(t.Integer({ minimum: 1 })),
        maxTicketsPerUser: t.Optional(t.Integer({ minimum: 1 })),
        winnersCount: t.Optional(t.Integer({ minimum: 1 })),
        games: t.Optional(t.Array(t.String())),
        finale: t.Optional(t.String()),
        closesAt: t.Optional(t.String()),
        status: t.Optional(t.String()),
      }),
    },
  )

  // Run the draw: fetch drand, compute the show, persist winners, reveal seed.
  .post("/raffles/:id/draw", async ({ params, set }) => {
    const raffle = await db.raffle.findUnique({ where: { id: params.id } });
    if (!raffle) {
      set.status = 404;
      return { error: "not_found" };
    }
    if (raffle.status === "DRAWN") {
      set.status = 409;
      return { error: "already_drawn" };
    }
    const tickets = await db.ticket.findMany({
      where: { raffleId: raffle.id },
      orderBy: { number: "asc" },
    });
    if (tickets.length < raffle.minTickets) {
      set.status = 422;
      return { error: "below_min_tickets", ticketCount: tickets.length, minTickets: raffle.minTickets };
    }

    const drand = await fetchDrandLatest();
    const ticketsRoot = await computeTicketsRoot(raffle.id);
    const publicEntropy = `${drand.round}:${drand.randomness}:${ticketsRoot}`;
    const digest = await hmacSha256Hex(raffle.serverSeed!, publicEntropy);

    const show = generateShow({
      digest,
      ticketCount: tickets.length,
      winnersCount: raffle.winnersCount,
      games: (raffle.games as GameType[]) ?? ["ELIMINATION"],
      finale: (raffle.finale as GameType) ?? null,
    });

    // Map winner indices (canonical order) → ticket rows.
    const winnerTickets = show.winners.map((idx) => tickets[idx]);

    await db.$transaction(async (tx) => {
      await tx.raffle.update({
        where: { id: raffle.id },
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
        const wt = winnerTickets[i];
        await tx.winner.create({
          data: { raffleId: raffle.id, ticketId: wt.id, userId: wt.ownerId, position: i + 1 },
        });
      }
      await tx.drawShow.create({
        data: {
          raffleId: raffle.id,
          stages: show as any,
          startsAt: new Date(),
          endsAt: new Date(),
        },
      });
    });

    return {
      ok: true,
      winners: winnerTickets.map((wt, i) => ({ position: i + 1, number: wt.number })),
      publicEntropy,
      digest,
      drandRound: drand.round,
    };
  })

  // Cancel a raffle and refund all spent lingotes.
  .post("/raffles/:id/cancel", async ({ params, set }) => {
    const raffle = await db.raffle.findUnique({ where: { id: params.id } });
    if (!raffle) {
      set.status = 404;
      return { error: "not_found" };
    }
    const orders = await db.order.findMany({
      where: { raffleId: raffle.id, status: "CONFIRMED" },
    });
    await db.$transaction(async (tx) => {
      for (const o of orders) {
        await applyLedger(tx, {
          userId: o.userId,
          amount: o.costLingotes,
          type: "REFUND",
          refType: "order",
          refId: o.id,
          memo: `Reembolso: ${raffle.title} cancelado`,
        });
        await tx.order.update({ where: { id: o.id }, data: { status: "REFUNDED" } });
      }
      await tx.raffle.update({ where: { id: raffle.id }, data: { status: "CANCELLED" } });
    });
    return { ok: true, refundedOrders: orders.length };
  })

  // --- Top-ups moderation ---
  .get("/topups", async ({ query }) => {
    const status = (query.status as string) ?? "PENDING";
    const topups = await db.topUp.findMany({
      where: { status: status as any },
      include: { user: { select: { email: true, nickname: true } } },
      orderBy: { createdAt: "desc" },
    });
    return topups;
  })

  .post("/topups/:id/approve", async ({ params, headers, set }) => {
    const topup = await db.topUp.findUnique({ where: { id: params.id } });
    if (!topup) {
      set.status = 404;
      return { error: "not_found" };
    }
    if (topup.status === "PAID") {
      set.status = 409;
      return { error: "already_paid" };
    }
    await db.$transaction(async (tx) => {
      await applyLedger(tx, {
        userId: topup.userId,
        amount: topup.lingotes,
        type: "TOPUP",
        refType: "topup",
        refId: topup.id,
        memo: `Recarga ${topup.method} $${(topup.amountUsd / 100).toFixed(2)}`,
      });
      await tx.topUp.update({
        where: { id: topup.id },
        data: { status: "PAID", confirmedAt: new Date() },
      });
    });
    return { ok: true, lingotes: topup.lingotes };
  })

  .post("/topups/:id/reject", async ({ params, set }) => {
    const topup = await db.topUp.findUnique({ where: { id: params.id } });
    if (!topup) {
      set.status = 404;
      return { error: "not_found" };
    }
    await db.topUp.update({ where: { id: params.id }, data: { status: "FAILED" } });
    return { ok: true };
  })

  .get("/orders", async () => {
    return db.order.findMany({
      include: {
        user: { select: { email: true, nickname: true } },
        raffle: { select: { title: true, slug: true } },
        tickets: { select: { number: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
  });
