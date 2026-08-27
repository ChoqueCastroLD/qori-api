import { Elysia, t } from "elysia";
import { db } from "../db";
import { createCommitment } from "../fair";
import { withUser } from "./auth";
import { executeDraw, refundRaffle } from "../lib/draw";
import { uploadObject, extForType, storageConfigured, MAX_UPLOAD_BYTES } from "../lib/storage";
import { getPayment } from "../lib/mercadopago";
import { getOrderBreakdown } from "../lib/paypal";
import { bustRafflesCache } from "../lib/rafflesCache";

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
          entropySource: "drand (round programada a la hora del sorteo) + raíz de tickets",
          commitment,
          serverSeed,
          status: (body.status ?? "OPEN") as any,
          opensAt: new Date(),
          closesAt: body.closesAt ? new Date(body.closesAt) : null,
        },
      });
      bustRafflesCache();
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

  // Upload a raffle image to R2, returns its public URL.
  .post(
    "/upload",
    async ({ body, set }) => {
      if (!storageConfigured()) { set.status = 503; return { error: "storage_not_configured" }; }
      const file = body.file as File;
      const ext = extForType(file.type);
      if (!ext) { set.status = 415; return { error: "unsupported_type" }; }
      if (file.size > MAX_UPLOAD_BYTES) { set.status = 413; return { error: "too_large" }; }
      try {
        const key = `raffles/${crypto.randomUUID()}.${ext}`;
        const url = await uploadObject(key, await file.arrayBuffer(), file.type);
        return { url };
      } catch (e) {
        set.status = 502;
        return { error: "upload_failed" };
      }
    },
    { body: t.Object({ file: t.File() }) },
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
    bustRafflesCache();
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
    bustRafflesCache();
    return { ok: true, refundedOrders };
  })

  // Block / unblock a raffle (with reason). Blocked raffles are hidden from the
  // public, can't sell tickets, and are skipped by the scheduler. Every toggle
  // is appended to blockHistory for the record.
  .post(
    "/raffles/:id/block",
    async ({ params, body, set }) => {
      const raffle = await db.raffle.findUnique({ where: { id: params.id } });
      if (!raffle) {
        set.status = 404;
        return { error: "not_found" };
      }
      const blocked = !!body.blocked;
      const reason = (body.reason ?? "").trim() || null;
      if (blocked && !reason) {
        set.status = 422;
        return { error: "reason_required" };
      }
      const prev = Array.isArray(raffle.blockHistory) ? (raffle.blockHistory as any[]) : [];
      const entry = { at: new Date().toISOString(), action: blocked ? "block" : "unblock", reason };
      const updated = await db.raffle.update({
        where: { id: params.id },
        data: { blocked, blockReason: blocked ? reason : null, blockHistory: [...prev, entry] as any },
      });
      bustRafflesCache();
      return { ok: true, blocked: updated.blocked, blockReason: updated.blockReason };
    },
    { body: t.Object({ blocked: t.Boolean(), reason: t.Optional(t.String()) }) },
  )

  // Edit a raffle. Only the fields sent are updated. Lets the admin set an exact
  // draw date/time (closesAt) or adjust limits after creation. A DRAWN or
  // CANCELLED raffle is locked (its outcome is already published).
  .patch(
    "/raffles/:id",
    async ({ params, body, set }) => {
      const raffle = await db.raffle.findUnique({ where: { id: params.id } });
      if (!raffle) {
        set.status = 404;
        return { error: "not_found" };
      }
      if (raffle.status === "DRAWN" || raffle.status === "CANCELLED") {
        set.status = 409;
        return { error: "locked", status: raffle.status };
      }
      const data: any = {};
      if (body.title !== undefined) data.title = body.title;
      if (body.description !== undefined) data.description = body.description;
      if (body.images !== undefined) data.images = body.images;
      if (body.prizeValue !== undefined) data.prizeValue = body.prizeValue;
      if (body.ticketPrice !== undefined) data.ticketPrice = body.ticketPrice;
      if (body.totalTickets !== undefined) data.totalTickets = body.totalTickets;
      if (body.minTickets !== undefined) data.minTickets = body.minTickets;
      if (body.maxTicketsPerUser !== undefined) data.maxTicketsPerUser = body.maxTicketsPerUser;
      if (body.winnersCount !== undefined) data.winnersCount = body.winnersCount;
      if (body.games !== undefined) data.games = body.games as any;
      if (body.finale !== undefined) data.finale = (body.finale || null) as any;
      if (body.status !== undefined) data.status = body.status as any;
      if (body.closesAt !== undefined) data.closesAt = body.closesAt ? new Date(body.closesAt) : null;
      const updated = await db.raffle.update({ where: { id: params.id }, data });
      bustRafflesCache();
      return { ok: true, id: updated.id, closesAt: updated.closesAt };
    },
    {
      body: t.Object({
        title: t.Optional(t.String()),
        description: t.Optional(t.String()),
        images: t.Optional(t.Array(t.String())),
        prizeValue: t.Optional(t.Integer()),
        ticketPrice: t.Optional(t.Integer({ minimum: 0 })),
        totalTickets: t.Optional(t.Integer({ minimum: 1 })),
        minTickets: t.Optional(t.Integer({ minimum: 1 })),
        maxTicketsPerUser: t.Optional(t.Integer({ minimum: 1 })),
        winnersCount: t.Optional(t.Integer({ minimum: 1 })),
        games: t.Optional(t.Array(t.String())),
        finale: t.Optional(t.String()),
        status: t.Optional(t.String()),
        closesAt: t.Optional(t.String()),
      }),
    },
  )

  // Per-raffle breakdown: economics + full participant table (who bought, when,
  // how many, their comment, account age, current lingote balance).
  .get("/raffles/:id/detail", async ({ params, set }) => {
    const raffle = await db.raffle.findUnique({ where: { id: params.id } });
    if (!raffle) {
      set.status = 404;
      return { error: "not_found" };
    }
    const orders = await db.order.findMany({
      where: { raffleId: raffle.id, status: "CONFIRMED" },
      include: {
        user: { select: { id: true, nickname: true, email: true, country: true, createdAt: true, balance: true } },
        tickets: { select: { number: true, comment: true } },
      },
      orderBy: { createdAt: "asc" },
    });
    const soldTickets = await db.ticket.count({ where: { raffleId: raffle.id, ownerId: { not: null } } });

    type Row = {
      userId: string; nickname: string | null; email: string; country: string | null;
      accountCreatedAt: Date; balance: number; tickets: number; lingotesSpent: number;
      firstBoughtAt: Date; lastBoughtAt: Date; numbers: number[]; comments: string[];
    };
    const byUser = new Map<string, Row>();
    for (const o of orders) {
      let row = byUser.get(o.userId);
      if (!row) {
        row = {
          userId: o.userId, nickname: o.user.nickname, email: o.user.email, country: o.user.country,
          accountCreatedAt: o.user.createdAt, balance: o.user.balance, tickets: 0, lingotesSpent: 0,
          firstBoughtAt: o.createdAt, lastBoughtAt: o.createdAt, numbers: [], comments: [],
        };
        byUser.set(o.userId, row);
      }
      row.tickets += o.quantity;
      row.lingotesSpent += o.costLingotes;
      if (o.createdAt < row.firstBoughtAt) row.firstBoughtAt = o.createdAt;
      if (o.createdAt > row.lastBoughtAt) row.lastBoughtAt = o.createdAt;
      for (const tk of o.tickets) {
        row.numbers.push(tk.number);
        if (tk.comment && tk.comment.trim()) row.comments.push(tk.comment.trim());
      }
    }
    const participants = [...byUser.values()].sort((a, b) => b.tickets - a.tickets);

    const revenueLingotes = orders.reduce((s, o) => s + o.costLingotes, 0);
    // 1 USD = 10 lingotes. Revenue is the real money value of tickets sold.
    const revenueUsdCents = Math.round((revenueLingotes / 10) * 100);
    const prizeCostUsdCents = raffle.legacy ? 0 : raffle.prizeValue;
    const profitUsdCents = revenueUsdCents - prizeCostUsdCents;

    return {
      raffle: {
        id: raffle.id, slug: raffle.slug, title: raffle.title, status: raffle.status,
        legacy: raffle.legacy, totalTickets: raffle.totalTickets, minTickets: raffle.minTickets,
        ticketPrice: raffle.ticketPrice, prizeValue: raffle.prizeValue,
        opensAt: raffle.opensAt, closesAt: raffle.closesAt, drawnAt: raffle.drawnAt,
        extensionCount: raffle.extensionCount, extensions: raffle.extensions ?? [],
      },
      metrics: {
        soldTickets,
        fillPct: raffle.totalTickets ? Math.round((soldTickets / raffle.totalTickets) * 100) : 0,
        uniqueBuyers: participants.length,
        orders: orders.length,
        revenueLingotes, revenueUsdCents, prizeCostUsdCents, profitUsdCents,
        reachedMin: soldTickets >= raffle.minTickets,
      },
      participants,
    };
  })

  // Platform-wide dashboard metrics.
  .get("/metrics", async () => {
    const now = Date.now();
    const weekAgo = new Date(now - 7 * 86400000);
    const [
      usersTotal, usersVerified, usersNew7d, rafflesGrouped, soldTickets,
      paidTopups, confirmedOrders, balanceAgg, drawnPrizes,
    ] = await Promise.all([
      db.user.count(),
      db.user.count({ where: { emailVerified: { not: null } } }),
      db.user.count({ where: { createdAt: { gte: weekAgo } } }),
      db.raffle.groupBy({ by: ["status"], _count: { _all: true } }),
      db.ticket.count({ where: { ownerId: { not: null } } }),
      db.topUp.aggregate({ where: { status: "PAID" }, _sum: { amountUsd: true, lingotes: true }, _count: { _all: true } }),
      db.order.aggregate({ where: { status: "CONFIRMED" }, _sum: { costLingotes: true }, _count: { _all: true } }),
      db.user.aggregate({ _sum: { balance: true } }),
      db.raffle.aggregate({ where: { status: "DRAWN", legacy: false }, _sum: { prizeValue: true }, _count: { _all: true } }),
    ]);
    const rafflesByStatus: Record<string, number> = {};
    for (const g of rafflesGrouped) rafflesByStatus[g.status] = g._count._all;

    const revenueUsdCents = paidTopups._sum.amountUsd ?? 0;
    const lingotesSold = paidTopups._sum.lingotes ?? 0;
    const lingotesSpent = confirmedOrders._sum.costLingotes ?? 0;
    const lingotesCirculating = balanceAgg._sum.balance ?? 0;
    const prizeAwardedUsdCents = drawnPrizes._sum.prizeValue ?? 0;

    return {
      users: { total: usersTotal, verified: usersVerified, new7d: usersNew7d },
      raffles: { byStatus: rafflesByStatus, drawn: drawnPrizes._count._all },
      tickets: { sold: soldTickets },
      money: {
        revenueUsdCents,
        topups: paidTopups._count._all,
        prizeAwardedUsdCents,
        grossMarginUsdCents: revenueUsdCents - prizeAwardedUsdCents,
        lingotesSold, lingotesSpent, lingotesCirculating,
        orders: confirmedOrders._count._all,
      },
    };
  })

  // Purchases (income): every recharge with the payment-processor fee breakdown.
  // Lazily backfills fee data for confirmed topups that predate fee capture.
  .get("/purchases", async () => {
    const missing = await db.topUp.findMany({
      where: { status: "PAID", grossAmount: null, providerRef: { not: null } },
      take: 50,
    });
    for (const t of missing) {
      try {
        let bd;
        if (t.method === "MERCADOPAGO") bd = (await getPayment(t.providerRef!))?.breakdown;
        else if (t.method === "PAYPAL") bd = await getOrderBreakdown(t.providerRef!);
        if (bd) await db.topUp.update({ where: { id: t.id }, data: bd });
      } catch {}
    }

    const rows = await db.topUp.findMany({
      orderBy: { createdAt: "desc" },
      take: 300,
      include: { user: { select: { email: true, nickname: true } } },
    });
    const purchases = rows.map((t) => {
      const feePct = t.grossAmount ? (t.feeAmount ?? 0) / t.grossAmount : null;
      const feeUsd = feePct != null ? Math.round(t.amountUsd * feePct) : null;
      const netUsd = feeUsd != null ? t.amountUsd - feeUsd : null;
      return {
        id: t.id, createdAt: t.createdAt, confirmedAt: t.confirmedAt, status: t.status,
        method: t.method, user: t.user, amountUsd: t.amountUsd, lingotes: t.lingotes,
        chargeCurrency: t.chargeCurrency, grossAmount: t.grossAmount, feeAmount: t.feeAmount,
        netAmount: t.netAmount, feePct, feeUsd, netUsd,
      };
    });
    const paid = purchases.filter((p) => p.status === "PAID");
    const withFee = paid.filter((p) => p.feeUsd != null);
    const grossUsd = paid.reduce((s, p) => s + p.amountUsd, 0);
    const feeUsd = withFee.reduce((s, p) => s + (p.feeUsd ?? 0), 0);
    const avgFeePct = withFee.length ? withFee.reduce((s, p) => s + (p.feePct ?? 0), 0) / withFee.length : null;
    return {
      purchases,
      totals: {
        count: paid.length,
        lingotes: paid.reduce((s, p) => s + p.lingotes, 0),
        grossUsd,
        feeUsd,
        netUsd: grossUsd - feeUsd,
        avgFeePct,
        missingFee: paid.length - withFee.length,
      },
    };
  })

  // Users list with activity + moderation flags (aggregated in a few queries).
  .get("/users", async () => {
    const users = await db.user.findMany({ orderBy: { createdAt: "desc" }, take: 500 });
    const [ticketsBy, ordersBy, refsBy, paidTopups] = await Promise.all([
      db.ticket.groupBy({ by: ["ownerId"], where: { ownerId: { not: null } }, _count: { _all: true } }),
      db.order.groupBy({ by: ["userId"], where: { status: "CONFIRMED" }, _count: { _all: true }, _sum: { costLingotes: true } }),
      db.user.groupBy({ by: ["referredById"], where: { referredById: { not: null } }, _count: { _all: true } }),
      db.topUp.findMany({ where: { status: "PAID" }, select: { userId: true, amountUsd: true, method: true } }),
    ]);
    const tMap = new Map(ticketsBy.map((t) => [t.ownerId, t._count._all]));
    const oMap = new Map(ordersBy.map((o) => [o.userId, o]));
    const rMap = new Map(refsBy.map((r) => [r.referredById, r._count._all]));
    const topMap = new Map<string, { count: number; usd: number; methods: Set<string> }>();
    for (const t of paidTopups) {
      let e = topMap.get(t.userId);
      if (!e) { e = { count: 0, usd: 0, methods: new Set() }; topMap.set(t.userId, e); }
      e.count++; e.usd += t.amountUsd; e.methods.add(t.method);
    }
    return users.map((u) => {
      const top = topMap.get(u.id);
      const ord = oMap.get(u.id);
      return {
        id: u.id, email: u.email, nickname: u.nickname, avatarUrl: u.avatarUrl,
        country: u.country, role: u.role, emailVerified: !!u.emailVerified, createdAt: u.createdAt,
        balance: u.balance, canChat: u.canChat, canBuy: u.canBuy, buyAttempts: u.buyAttempts,
        referralCode: u.referralCode,
        ticketsOwned: tMap.get(u.id) ?? 0,
        orders: ord?._count._all ?? 0,
        lingotesSpent: ord?._sum.costLingotes ?? 0,
        referralsCount: rMap.get(u.id) ?? 0,
        topupCount: top?.count ?? 0,
        spentUsd: top?.usd ?? 0,
        methods: top ? [...top.methods] : [],
      };
    });
  })

  // Toggle a user's moderation switches (chat / buy).
  .post(
    "/users/:id/flags",
    async ({ params, body, set }) => {
      const data: any = {};
      if (body.canChat !== undefined) data.canChat = body.canChat;
      if (body.canBuy !== undefined) data.canBuy = body.canBuy;
      if (Object.keys(data).length === 0) { set.status = 422; return { error: "no_fields" }; }
      const u = await db.user.update({ where: { id: params.id }, data }).catch(() => null);
      if (!u) { set.status = 404; return { error: "not_found" }; }
      return { ok: true, canChat: u.canChat, canBuy: u.canBuy };
    },
    { body: t.Object({ canChat: t.Optional(t.Boolean()), canBuy: t.Optional(t.Boolean()) }) },
  )

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
