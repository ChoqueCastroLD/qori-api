import { Elysia, t } from "elysia";
import { db } from "../db";
import { createCommitment } from "../fair";
import { withUser } from "./auth";
import { executeDraw, refundRaffle } from "../lib/draw";

const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "";

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
    // drandRound is BigInt — not JSON-serializable; expose as string.
    return raffles.map((r) => ({ ...r, drandRound: r.drandRound != null ? r.drandRound.toString() : null }));
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

  // Run the draw now (manual). Uses the shared engine (drand + show + reveal).
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
    const count = await db.ticket.count({ where: { raffleId: raffle.id } });
    if (count < raffle.minTickets) {
      set.status = 422;
      return { error: "below_min_tickets", ticketCount: count, minTickets: raffle.minTickets };
    }
    const result = await executeDraw(raffle.id);
    if (!result) {
      set.status = 409;
      return { error: "already_claimed" };
    }
    return { ok: true, ...result };
  })

  // Cancel a raffle and refund all spent lingotes.
  .post("/raffles/:id/cancel", async ({ params, set }) => {
    const raffle = await db.raffle.findUnique({ where: { id: params.id } });
    if (!raffle) {
      set.status = 404;
      return { error: "not_found" };
    }
    const refundedOrders = await refundRaffle(raffle.id);
    return { ok: true, refundedOrders };
  })

  // Read-only topups view (all recharges are automatic via MP/PayPal now; no
  // manual approval — that could credit unconfirmed payments).
  .get("/topups", async ({ query }) => {
    const status = (query.status as string) ?? "PAID";
    return db.topUp.findMany({
      where: { status: status as any },
      include: { user: { select: { email: true, nickname: true } } },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
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
