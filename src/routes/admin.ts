import { Elysia, t } from "elysia";
import { db } from "../db";
import { createCommitment } from "../fair";
import { withUser } from "./auth";
import { executeDraw, refundRaffle } from "../lib/draw";
import { uploadObject, extForType, storageConfigured, MAX_UPLOAD_BYTES } from "../lib/storage";
import { getPayment } from "../lib/mercadopago";
import { getOrderBreakdown } from "../lib/paypal";
import { bustRafflesCache } from "../lib/rafflesCache";
import { sendEmail, prizeClaimEmail, promoDuplicaEmail } from "../lib/email";
import { newClaimCode } from "../lib/claim";
import { creditTopupIfPending } from "../lib/topups";
import { applyLedger } from "../lib/wallet";
import { suertudoSet } from "../lib/suertudo";
import { getStatusByCommerce as flowStatusByCommerce } from "../lib/flow";

const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "";
// Affiliates: cash paid per VALID referral (referred user who spent real money).
const PAYOUT_PER_VALID_CENTS = 50; // $0.50 each ($5 per 10)

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
      include: { _count: { select: { tickets: true, orders: true, bingoCards: true } } },
    });
    // drandRound is BigInt - not JSON-serializable; expose as string.
    return raffles.map((r) => ({ ...r, drandRound: r.drandRound != null ? r.drandRound.toString() : null }));
  })

  // Create a raffle (auto-commitment, opens immediately).
  .post(
    "/raffles",
    async ({ body, set }) => {
      // URL-safe slug; anything else breaks /sorteos/:slug routing.
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(body.slug)) {
        set.status = 422;
        return { error: "invalid_slug" };
      }
      const games = (body.games ?? ["ROCKETS", "BOMBS", "ROULETTE"]) as string[];
      const finale = body.finale ?? "ROULETTE";
      if (games.length === 0 || !games.includes(finale)) {
        set.status = 422;
        return { error: "finale_not_in_games" };
      }
      const existing = await db.raffle.findUnique({ where: { slug: body.slug } });
      if (existing) {
        set.status = 409;
        return { error: "slug_taken" };
      }
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
          paidOnly: body.paidOnly ?? false,
          games: games as any,
          finale: finale as any,
          showVersion: 2, // new raffles use the per-game sim engine
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
        minTickets: t.Optional(t.Integer({ minimum: 0 })),
        maxTicketsPerUser: t.Optional(t.Integer({ minimum: 1 })),
        winnersCount: t.Optional(t.Integer({ minimum: 1 })),
        paidOnly: t.Optional(t.Boolean()),
        games: t.Optional(t.Array(t.String())),
        finale: t.Optional(t.String()),
        closesAt: t.Optional(t.String()),
        status: t.Optional(t.String()),
      }),
    },
  )

  // Create a BINGO raffle (auto-commitment). ticketPrice = lingotes per CARD,
  // totalTickets = total card cap, maxTicketsPerUser = max cards per user.
  // Born DRAFT by default so it never touches live raffles until we flip it.
  .post(
    "/bingo",
    async ({ body, set }) => {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(body.slug)) {
        set.status = 422;
        return { error: "invalid_slug" };
      }
      const existing = await db.raffle.findUnique({ where: { slug: body.slug } });
      if (existing) {
        set.status = 409;
        return { error: "slug_taken" };
      }
      const { serverSeed, commitment } = await createCommitment();
      const raffle = await db.raffle.create({
        data: {
          kind: "BINGO",
          slug: body.slug,
          title: body.title,
          description: body.description,
          images: body.images ?? [],
          prizeValue: body.prizeValue,
          ticketPrice: body.ticketPrice,
          totalTickets: body.totalTickets,
          minTickets: body.minTickets ?? 1,
          maxTicketsPerUser: body.maxTicketsPerUser ?? null,
          winnersCount: 1, // advisory; a same-ball tie splits the prize by USD value
          bingoIntervalSec: body.intervalSec != null ? Math.min(60, Math.max(6, body.intervalSec)) : null,
          paidOnly: body.paidOnly ?? false,
          games: [],
          entropySource: "drand (round programada a la hora del sorteo) + raíz de cartones",
          commitment,
          serverSeed,
          status: (body.status ?? "DRAFT") as any,
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
        minTickets: t.Optional(t.Integer({ minimum: 0 })),
        maxTicketsPerUser: t.Optional(t.Integer({ minimum: 1 })),
        intervalSec: t.Optional(t.Integer({ minimum: 6, maximum: 60 })),
        paidOnly: t.Optional(t.Boolean()),
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
    const count = raffle.kind === "BINGO"
      ? await db.bingoCard.count({ where: { raffleId: raffle.id } })
      : await db.ticket.count({ where: { raffleId: raffle.id } });
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
      // Finished/cancelled raffles are locked EXCEPT legacy (historical) ones,
      // which stay editable for cosmetics only (title/description/images).
      const finished = raffle.status === "DRAWN" || raffle.status === "CANCELLED";
      if (finished && !raffle.legacy) {
        set.status = 409;
        return { error: "locked", status: raffle.status };
      }
      const cosmeticOnly = raffle.legacy;
      // Never shrink capacity below what's already sold.
      if (body.totalTickets !== undefined) {
        const soldNow = await db.ticket.count({ where: { raffleId: raffle.id } });
        if (body.totalTickets < soldNow) {
          set.status = 422;
          return { error: "total_below_sold", sold: soldNow };
        }
      }
      // Keep games/finale consistent: the finale must be one of the games.
      if (body.games !== undefined || body.finale !== undefined) {
        const games = (body.games ?? (raffle.games as any) ?? []) as string[];
        const finale = body.finale !== undefined ? body.finale : (raffle.finale as any);
        if (finale && (games.length === 0 || !games.includes(finale))) {
          set.status = 422;
          return { error: "finale_not_in_games" };
        }
      }
      const data: any = {};
      if (body.title !== undefined) data.title = body.title;
      if (body.description !== undefined) data.description = body.description;
      if (body.images !== undefined) data.images = body.images;
      if (!cosmeticOnly) {
        if (body.prizeValue !== undefined) data.prizeValue = body.prizeValue;
        if (body.ticketPrice !== undefined) data.ticketPrice = body.ticketPrice;
        if (body.totalTickets !== undefined) data.totalTickets = body.totalTickets;
        if (body.minTickets !== undefined) data.minTickets = body.minTickets;
        if (body.maxTicketsPerUser !== undefined) data.maxTicketsPerUser = body.maxTicketsPerUser;
        if (body.winnersCount !== undefined) data.winnersCount = body.winnersCount;
        if (body.paidOnly !== undefined) data.paidOnly = body.paidOnly;
        if (body.games !== undefined) data.games = body.games as any;
        if (body.finale !== undefined) data.finale = (body.finale || null) as any;
        if (body.status !== undefined) data.status = body.status as any;
        if (body.intervalSec !== undefined) data.bingoIntervalSec = Math.min(60, Math.max(6, body.intervalSec));
        if (body.closesAt !== undefined) data.closesAt = body.closesAt ? new Date(body.closesAt) : null;
      }
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
        minTickets: t.Optional(t.Integer({ minimum: 0 })),
        maxTicketsPerUser: t.Optional(t.Integer({ minimum: 1 })),
        winnersCount: t.Optional(t.Integer({ minimum: 1 })),
        paidOnly: t.Optional(t.Boolean()),
        games: t.Optional(t.Array(t.String())),
        finale: t.Optional(t.String()),
        status: t.Optional(t.String()),
        closesAt: t.Optional(t.String()),
        intervalSec: t.Optional(t.Integer({ minimum: 6, maximum: 60 })),
      }),
    },
  )

  // Hard-delete a raffle and everything tied to it (tickets, orders, winners,
  // notification log, and - via cascade - its show + chat). Ledger entries are
  // history and are left intact. Irreversible; intended for test raffles.
  .delete("/raffles/:id", async ({ params, set }) => {
    const raffle = await db.raffle.findUnique({ where: { id: params.id } });
    if (!raffle) { set.status = 404; return { error: "not_found" }; }
    const res = await db.$transaction(async (tx) => {
      // Bingo tables first (FK RESTRICT from wins -> cards -> raffle).
      const bw = await tx.bingoWin.deleteMany({ where: { raffleId: params.id } });
      const bc = await tx.bingoCard.deleteMany({ where: { raffleId: params.id } });
      await tx.bingoGame.deleteMany({ where: { raffleId: params.id } });
      const w = await tx.winner.deleteMany({ where: { raffleId: params.id } });
      const t = await tx.ticket.deleteMany({ where: { raffleId: params.id } });
      const o = await tx.order.deleteMany({ where: { raffleId: params.id } });
      await tx.notificationLog.deleteMany({ where: { raffleId: params.id } });
      await tx.raffle.delete({ where: { id: params.id } });
      return { winners: w.count, tickets: t.count, orders: o.count, bingoWins: bw.count, bingoCards: bc.count };
    });
    bustRafflesCache();
    return { ok: true, deleted: { slug: raffle.slug, ...res } };
  })

  // --- Prize winners: list, mark delivered, and notify (backfill) ---
  .get("/winners", async () => {
    const winners = await db.winner.findMany({
      include: {
        raffle: { select: { slug: true, title: true, prizeValue: true, drawnAt: true, legacy: true } },
        ticket: { select: { number: true } },
        user: { select: { nickname: true, email: true, username: true } },
      },
      orderBy: [{ createdAt: "desc" }],
    });
    return winners.map((w) => ({
      id: w.id, position: w.position, prizeStatus: w.prizeStatus, claimCode: w.claimCode,
      notifiedAt: w.notifiedAt, deliveredAt: w.deliveredAt, ticketNumber: w.ticket?.number ?? null,
      name: w.name ?? w.user?.nickname ?? null, email: w.user?.email ?? null, username: w.user?.username ?? null,
      raffle: { slug: w.raffle.slug, title: w.raffle.title, prizeValue: w.raffle.prizeValue, drawnAt: w.raffle.drawnAt, legacy: w.raffle.legacy },
    }));
  })
  .patch(
    "/winners/:id",
    async ({ params, body, set }) => {
      const w = await db.winner.findUnique({ where: { id: params.id } });
      if (!w) { set.status = 404; return { error: "not_found" }; }
      const status = body.prizeStatus === "DELIVERED" ? "DELIVERED" : "PENDING";
      await db.winner.update({ where: { id: params.id }, data: { prizeStatus: status, deliveredAt: status === "DELIVERED" ? (w.deliveredAt ?? new Date()) : null } });
      return { ok: true, prizeStatus: status };
    },
    { body: t.Object({ prizeStatus: t.String() }) },
  )

  // Deliver a lingote prize to a winner: credit their balance and mark the
  // prize DELIVERED, atomically. Idempotent - a second call for the same winner
  // does not double-credit (guards on an existing ledger entry).
  .post(
    "/winners/:id/deliver-lingotes",
    async ({ params, body, set }) => {
      const w = await db.winner.findUnique({ where: { id: params.id } });
      if (!w) { set.status = 404; return { error: "not_found" }; }
      if (!w.userId) { set.status = 422; return { error: "no_user" }; }
      const existing = await db.ledgerEntry.findFirst({ where: { refType: "winner_prize", refId: w.id } });
      if (existing) {
        if (w.prizeStatus !== "DELIVERED") {
          await db.winner.update({ where: { id: w.id }, data: { prizeStatus: "DELIVERED", deliveredAt: w.deliveredAt ?? new Date() } });
        }
        return { ok: true, already: true, lingotes: existing.amount };
      }
      await db.$transaction(async (tx) => {
        await applyLedger(tx, {
          userId: w.userId!,
          amount: body.lingotes,
          type: "ADJUSTMENT",
          refType: "winner_prize",
          refId: w.id,
          memo: `Premio del sorteo (${body.lingotes} lingote${body.lingotes === 1 ? "" : "s"})`,
        });
        await tx.winner.update({ where: { id: w.id }, data: { prizeStatus: "DELIVERED", deliveredAt: new Date() } });
      });
      return { ok: true, credited: body.lingotes };
    },
    { body: t.Object({ lingotes: t.Integer({ minimum: 1, maximum: 100000 }) }) },
  )

  // Set a user's lingote balance to an exact value (manual correction). Applies
  // the difference as a ledger ADJUSTMENT so the balance stays auditable.
  .post(
    "/set-balance",
    async ({ body, set }) => {
      const u = body.email
        ? await db.user.findUnique({ where: { email: body.email.toLowerCase() }, select: { id: true, balance: true } })
        : body.username
          ? await db.user.findUnique({ where: { username: body.username.toLowerCase() }, select: { id: true, balance: true } })
          : null;
      if (!u) { set.status = 404; return { error: "not_found" }; }
      const delta = body.lingotes - u.balance;
      if (delta !== 0) {
        await db.$transaction(async (tx) => {
          await applyLedger(tx, { userId: u.id, amount: delta, type: "ADJUSTMENT", refType: "admin_set_balance", memo: `Ajuste manual de saldo a ${body.lingotes}` });
        });
      }
      const after = await db.user.findUnique({ where: { id: u.id }, select: { balance: true } });
      return { ok: true, before: u.balance, after: after?.balance ?? body.lingotes };
    },
    { body: t.Object({ username: t.Optional(t.String()), email: t.Optional(t.String()), lingotes: t.Integer({ minimum: 0, maximum: 10000000 }) }) },
  )
  // Backfill: email past winners (platform account, non-legacy, not yet notified)
  // their claim code. `?dryRun=1` previews recipients without sending.
  .post("/winners/notify", async ({ query }) => {
    const dryRun = query.dryRun === "1" || query.dryRun === "true";
    const force = query.force === "1" || query.force === "true"; // resend even if already notified
    const winners = await db.winner.findMany({
      where: { ...(force ? {} : { notifiedAt: null }), prizeStatus: { not: "DELIVERED" }, userId: { not: null }, raffle: { legacy: false } },
      include: { raffle: { select: { title: true, slug: true, prizeValue: true } }, ticket: { select: { number: true } }, user: { select: { email: true } } },
    });
    const targets = winners.filter((w) => w.user?.email);
    if (dryRun) return { dryRun: true, count: targets.length, recipients: targets.map((w) => ({ email: w.user!.email, raffle: w.raffle.title })) };
    const results: { email: string; ok: boolean }[] = [];
    for (const w of targets) {
      const code = w.claimCode ?? (await newClaimCode());
      const ok = await sendEmail({ to: w.user!.email!, ...prizeClaimEmail(w.raffle.title, w.ticket?.number ?? 0, w.raffle.prizeValue, code, w.raffle.slug) }).catch(() => false);
      await db.winner.update({ where: { id: w.id }, data: { notifiedAt: new Date(), ...(w.claimCode ? {} : { claimCode: code }) } });
      results.push({ email: w.user!.email!, ok: !!ok });
    }
    return { ok: true, sent: results.filter((r) => r.ok).length, attempted: results.length, results };
  })
  // Broadcast the promo email to ALL users with an email. `?dryRun=1` previews
  // the recipient count without sending.
  .post("/promo-email/send", async ({ query }) => {
    const users = await db.user.findMany({ select: { email: true } });
    const emails = [...new Set(users.map((u) => u.email).filter((e): e is string => !!e))];
    // Safety: this is a mass outbound blast. Only send with ?confirm=SEND; any
    // other call (incl. ?dryRun=1) just returns the recipient count.
    if (query.confirm !== "SEND") return { dryRun: true, count: emails.length };
    const mail = promoDuplicaEmail();
    let sent = 0;
    for (const email of emails) { const ok = await sendEmail({ to: email, ...mail }).catch(() => false); if (ok) sent++; }
    return { ok: true, sent, total: emails.length };
  })
  // Send the "duplica tus tickets" promo email to one address (draft/preview).
  .post(
    "/promo-email/test",
    async ({ body, set }) => {
      const email = (body.email || "").trim();
      if (!email) { set.status = 422; return { error: "email_required" }; }
      const ok = await sendEmail({ to: email, ...promoDuplicaEmail() }).catch(() => false);
      return { ok: !!ok, sentTo: email };
    },
    { body: t.Object({ email: t.String() }) },
  )
  // Send a SAMPLE claim email to any address (to preview the design).
  .post(
    "/winners/test-email",
    async ({ body, set }) => {
      const email = (body.email || "").trim();
      if (!email) { set.status = 422; return { error: "email_required" }; }
      const code = await newClaimCode();
      const ok = await sendEmail({ to: email, ...prizeClaimEmail("iPhone 15 Pro (ejemplo)", 777, 120000, code, "ejemplo") }).catch(() => false);
      return { ok: !!ok, sentTo: email };
    },
    { body: t.Object({ email: t.String() }) },
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
      paidTopups, confirmedOrders, balanceAgg, drawnPrizes, offeredPrizes,
      showWinners, bingoWinners,
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
      // Prizes "offered": every non-legacy raffle that reached the public (open,
      // closing, drawing or drawn) — the total value we've put on the table.
      db.raffle.aggregate({ where: { legacy: false, status: { in: ["OPEN", "CLOSED", "DRAWING", "DRAWN"] } }, _sum: { prizeValue: true }, _count: { _all: true } }),
      db.winner.count(),
      db.bingoWin.count(),
    ]);
    const rafflesByStatus: Record<string, number> = {};
    for (const g of rafflesGrouped) rafflesByStatus[g.status] = g._count._all;

    const revenueUsdCents = paidTopups._sum.amountUsd ?? 0;
    const lingotesSold = paidTopups._sum.lingotes ?? 0;
    const lingotesSpent = confirmedOrders._sum.costLingotes ?? 0;
    const lingotesCirculating = balanceAgg._sum.balance ?? 0;
    const prizeAwardedUsdCents = drawnPrizes._sum.prizeValue ?? 0;
    const prizeOfferedUsdCents = offeredPrizes._sum.prizeValue ?? 0;
    const winnersTotal = showWinners + bingoWinners;

    return {
      users: { total: usersTotal, verified: usersVerified, new7d: usersNew7d },
      raffles: { byStatus: rafflesByStatus, drawn: drawnPrizes._count._all, offered: offeredPrizes._count._all },
      tickets: { sold: soldTickets },
      winners: { total: winnersTotal },
      money: {
        revenueUsdCents,
        topups: paidTopups._count._all,
        prizeAwardedUsdCents,
        prizeOfferedUsdCents,
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

  // Growth dashboard: acquisition + retention funnel. Answers "are we getting
  // people, do they buy, do they come back?" so loss-leader raffles can be
  // judged on repeat-recharge, not vanity ticket counts.
  .get("/growth", async () => {
    const now = Date.now();
    const since = new Date(now - 30 * 86400000);
    const [totalUsers, recentUsers, ordersBy, topupsBy] = await Promise.all([
      db.user.count(),
      db.user.findMany({ where: { createdAt: { gte: since } }, select: { createdAt: true } }),
      db.order.groupBy({ by: ["userId"], where: { status: "CONFIRMED" }, _count: { _all: true } }),
      db.topUp.groupBy({ by: ["userId"], where: { status: "PAID" }, _count: { _all: true }, _sum: { amountUsd: true } }),
    ]);
    // New users per day over the last 30 days, zero-filled so the chart is continuous.
    const byDay = new Map<string, number>();
    for (const u of recentUsers) {
      const d = u.createdAt.toISOString().slice(0, 10);
      byDay.set(d, (byDay.get(d) ?? 0) + 1);
    }
    const newUsersByDay: { date: string; count: number }[] = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now - i * 86400000).toISOString().slice(0, 10);
      newUsersByDay.push({ date: d, count: byDay.get(d) ?? 0 });
    }
    const buyers = ordersBy.length; // distinct users who ever took a ticket
    const rechargers = topupsBy.length; // distinct users who ever paid real money
    const repeatRechargers = topupsBy.filter((t) => t._count._all >= 2).length;
    const revenueUsd = topupsBy.reduce((s, t) => s + (t._sum.amountUsd ?? 0), 0) / 100;
    return {
      totalUsers,
      newLast30: recentUsers.length,
      buyers,
      rechargers,
      repeatRechargers,
      revenueUsd,
      conv: {
        registeredToRecharged: totalUsers ? rechargers / totalUsers : 0,
        rechargedToRepeat: rechargers ? repeatRechargers / rechargers : 0,
      },
      newUsersByDay,
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
  // manual approval - that could credit unconfirmed payments).
  .get("/topups", async ({ query, set }) => {
    const status = (query.status as string) ?? "PAID";
    if (!["PAID", "PENDING", "FAILED", "REFUNDED"].includes(status)) {
      set.status = 422;
      return { error: "invalid_status" };
    }
    return db.topUp.findMany({
      where: { status: status as any },
      include: { user: { select: { email: true, nickname: true } } },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
  })

  // Confirm a MANUAL topup (crypto/Binance and other proof-based methods),
  // crediting lingotes once. Never allowed for MP/PayPal (those are automatic;
  // confirming by hand could credit an unconfirmed card payment).
  .post("/topups/:id/confirm", async ({ params, user, set }) => {
    const topup = await db.topUp.findUnique({ where: { id: params.id } });
    if (!topup) { set.status = 404; return { error: "not_found" }; }
    if (topup.status === "PAID") return { ok: true, already: true };
    if (!["CRYPTO", "YAPE", "PLIN", "TRANSFER"].includes(topup.method)) {
      set.status = 422;
      return { error: "not_a_manual_method" };
    }
    const credited = await creditTopupIfPending(topup.id, { memoLabel: "Recarga Binance" });
    if (credited && user?.id) {
      await db.topUp.update({ where: { id: topup.id }, data: { confirmedById: user.id } }).catch(() => {});
    }
    return { ok: true, credited };
  })

  // Reject / fail a pending manual topup.
  .post("/topups/:id/reject", async ({ params, set }) => {
    const topup = await db.topUp.findUnique({ where: { id: params.id } });
    if (!topup) { set.status = 404; return { error: "not_found" }; }
    if (topup.status === "PAID") { set.status = 422; return { error: "already_paid" }; }
    await db.topUp.update({ where: { id: params.id }, data: { status: "FAILED" } });
    return { ok: true };
  })

  // Create a DIRECT top-up (payment received off-gateway, e.g. transfer/cash):
  // records it as PAID with zero commission (net = gross) and credits lingotes.
  .post(
    "/topups/direct",
    async ({ body, set }) => {
      const u = body.email
        ? await db.user.findUnique({ where: { email: body.email.toLowerCase() }, select: { id: true } })
        : body.username
          ? await db.user.findUnique({ where: { username: body.username.toLowerCase() }, select: { id: true } })
          : null;
      if (!u) { set.status = 404; return { error: "not_found" }; }
      const amountUsd = body.amountUsd; // cents
      const lingotes = body.lingotes;
      const topup = await db.$transaction(async (tx) => {
        const t = await tx.topUp.create({
          data: {
            userId: u.id, amountUsd, lingotes, method: "DIRECTO", status: "PAID",
            chargeCurrency: "USD", grossAmount: amountUsd, feeAmount: 0, netAmount: amountUsd,
            confirmedAt: new Date(),
          },
        });
        await applyLedger(tx, { userId: u.id, amount: lingotes, type: "TOPUP", refType: "topup", refId: t.id, memo: `Recarga directa $${(amountUsd / 100).toFixed(2)}` });
        return t;
      });
      return { ok: true, topupId: topup.id, amountUsd, lingotes };
    },
    { body: t.Object({ email: t.Optional(t.String()), username: t.Optional(t.String()), amountUsd: t.Integer({ minimum: 1 }), lingotes: t.Integer({ minimum: 1 }) }) },
  )

  // Backfill Flow commission/net for paid Flow top-ups that were credited before
  // fee capture (queries Flow by our commerceOrder = topup id).
  .post("/flow/backfill-fees", async () => {
    const topups = await db.topUp.findMany({ where: { method: "FLOW", status: "PAID", feeAmount: null }, select: { id: true } });
    let updated = 0;
    for (const t of topups) {
      const st = await flowStatusByCommerce(t.id).catch(() => null);
      if (st?.breakdown) {
        await db.topUp.update({ where: { id: t.id }, data: { chargeCurrency: st.breakdown.chargeCurrency, grossAmount: st.breakdown.grossAmount, feeAmount: st.breakdown.feeAmount, netAmount: st.breakdown.netAmount } });
        updated++;
      }
    }
    return { ok: true, checked: topups.length, updated };
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
  })

  // ---- Affiliates module (scan/brand partners) ----
  // Paid PER VALID REFERRAL: a referred user who spent real money (>=1 PAID
  // top-up). Separate from the user-to-user referral system.
  .get("/affiliates", async () => {
    const [affiliates, users, paidRows] = await Promise.all([
      db.affiliate.findMany({ orderBy: { createdAt: "desc" } }),
      db.user.findMany({ where: { affiliateId: { not: null } }, select: { id: true, affiliateId: true } }),
      db.topUp.findMany({ where: { status: "PAID" }, distinct: ["userId"], select: { userId: true } }),
    ]);
    const paid = new Set(paidRows.map((r) => r.userId));
    const visitRows = await db.refVisit.findMany({ where: { code: { in: affiliates.map((a) => a.code) } } });
    const visitMap = new Map(visitRows.map((v) => [v.code, v.count]));
    const signup = new Map<string, number>();
    const valid = new Map<string, number>();
    for (const u of users) {
      signup.set(u.affiliateId!, (signup.get(u.affiliateId!) ?? 0) + 1);
      if (paid.has(u.id)) valid.set(u.affiliateId!, (valid.get(u.affiliateId!) ?? 0) + 1);
    }
    return affiliates.map((a) => {
      const signups = signup.get(a.id) ?? 0;
      const validRefs = valid.get(a.id) ?? 0;
      const earnedUsdCents = validRefs * PAYOUT_PER_VALID_CENTS;
      return {
        id: a.id, code: a.code, name: a.name, note: a.note, active: a.active, createdAt: a.createdAt,
        visits: visitMap.get(a.code) ?? 0, signups, validRefs, earnedUsdCents, paidUsdCents: a.paidUsd,
        owedUsdCents: Math.max(0, earnedUsdCents - a.paidUsd),
      };
    });
  })

  .post(
    "/affiliates",
    async ({ body, set }) => {
      const code = body.code.trim().toLowerCase();
      if (!/^[a-z0-9]([a-z0-9-]{1,30}[a-z0-9])?$/.test(code)) { set.status = 422; return { error: "invalid_code" }; }
      const exists = await db.affiliate.findUnique({ where: { code } });
      if (exists) { set.status = 409; return { error: "code_taken" }; }
      const userCode = await db.user.findUnique({ where: { referralCode: code.toUpperCase() }, select: { id: true } });
      if (userCode) { set.status = 409; return { error: "code_taken" }; }
      const a = await db.affiliate.create({ data: { code, name: body.name.trim(), note: body.note?.trim() || null } });
      return { ok: true, id: a.id, code: a.code };
    },
    { body: t.Object({ code: t.String(), name: t.String(), note: t.Optional(t.String()) }) },
  )

  .patch(
    "/affiliates/:id",
    async ({ params, body, set }) => {
      const data: any = {};
      if (body.name !== undefined) data.name = body.name.trim();
      if (body.note !== undefined) data.note = body.note.trim() || null;
      if (body.active !== undefined) data.active = body.active;
      if (body.code !== undefined) {
        const code = body.code.trim().toLowerCase();
        if (!/^[a-z0-9]([a-z0-9-]{1,30}[a-z0-9])?$/.test(code)) { set.status = 422; return { error: "invalid_code" }; }
        const clash = await db.affiliate.findFirst({ where: { code, id: { not: params.id } } });
        const userClash = await db.user.findUnique({ where: { referralCode: code.toUpperCase() }, select: { id: true } });
        if (clash || userClash) { set.status = 409; return { error: "code_taken" }; }
        data.code = code;
      }
      const a = await db.affiliate.update({ where: { id: params.id }, data }).catch(() => null);
      if (!a) { set.status = 404; return { error: "not_found" }; }
      return { ok: true, code: a.code };
    },
    { body: t.Object({ code: t.Optional(t.String()), name: t.Optional(t.String()), note: t.Optional(t.String()), active: t.Optional(t.Boolean()) }) },
  )

  // Record a cash payout to an affiliate (adds to the paid total).
  .post(
    "/affiliates/:id/payout",
    async ({ params, body, set }) => {
      const a = await db.affiliate.findUnique({ where: { id: params.id } });
      if (!a) { set.status = 404; return { error: "not_found" }; }
      const cents = Math.round(body.usd * 100);
      const updated = await db.affiliate.update({ where: { id: params.id }, data: { paidUsd: a.paidUsd + cents } });
      return { ok: true, paidUsdCents: updated.paidUsd };
    },
    { body: t.Object({ usd: t.Number({ minimum: 0 }) }) },
  )

  // Referral traffic stats: how people registered via any ?ref code, incl.
  // UNKNOWN codes (matched no user/affiliate) so we can investigate misuse.
  .get("/referral-stats", async () => {
    const [totalUsers, withCode, viaAffiliate, viaUser] = await Promise.all([
      db.user.count(),
      db.user.count({ where: { refCode: { not: null } } }),
      db.user.count({ where: { affiliateId: { not: null } } }),
      db.user.count({ where: { referredById: { not: null } } }),
    ]);
    const unknownUsers = await db.user.findMany({
      where: { refCode: { not: null }, affiliateId: null, referredById: null },
      select: { id: true, refCode: true },
    });
    const paid = await suertudoSet(unknownUsers.map((u) => u.id));
    const map = new Map<string, { count: number; bought: number }>();
    for (const u of unknownUsers) {
      const e = map.get(u.refCode!) ?? { count: 0, bought: 0 };
      e.count++; if (paid.has(u.id)) e.bought++;
      map.set(u.refCode!, e);
    }
    const unknownCodes = [...map.keys()];
    const [totalVisitsAgg, unknownVisits] = await Promise.all([
      db.refVisit.aggregate({ _sum: { count: true } }),
      unknownCodes.length ? db.refVisit.findMany({ where: { code: { in: unknownCodes } } }) : Promise.resolve([]),
    ]);
    const uv = new Map(unknownVisits.map((v) => [v.code, v.count]));
    const unknown = [...map.entries()].map(([code, e]) => ({ code, count: e.count, bought: e.bought, visits: uv.get(code) ?? 0 })).sort((a, b) => b.count - a.count);

    // Every code with visits, classified, with its funnel: visitas -> registros
    // -> referidos (a referido counts only when the registered user PAID).
    const allVisits = await db.refVisit.findMany({ take: 200 });
    const allCodes = allVisits.map((v) => v.code);
    const [affCodesRows, userCodeRows, regUsers] = await Promise.all([
      db.affiliate.findMany({ where: { code: { in: allCodes } }, select: { code: true } }),
      db.user.findMany({ where: { referralCode: { in: allCodes.map((c) => c.toUpperCase()) } }, select: { referralCode: true } }),
      db.user.findMany({ where: { refCode: { in: allCodes } }, select: { id: true, refCode: true } }),
    ]);
    const affSet = new Set(affCodesRows.map((a) => a.code));
    const userSet = new Set(userCodeRows.map((u) => u.referralCode.toLowerCase()));
    const paidReg = await suertudoSet(regUsers.map((u) => u.id));
    const regMap = new Map<string, number>(), refMap = new Map<string, number>();
    for (const u of regUsers) {
      regMap.set(u.refCode!, (regMap.get(u.refCode!) ?? 0) + 1);
      if (paidReg.has(u.id)) refMap.set(u.refCode!, (refMap.get(u.refCode!) ?? 0) + 1);
    }
    const topVisits = allVisits.map((v) => ({
      code: v.code,
      visits: v.count,
      type: affSet.has(v.code) ? "affiliate" : userSet.has(v.code) ? "user" : "unknown",
      registrations: regMap.get(v.code) ?? 0,
      referidos: refMap.get(v.code) ?? 0,
    })).sort((a, b) => b.referidos - a.referidos || b.registrations - a.registrations || b.visits - a.visits);
    return { totalUsers, withCode, viaAffiliate, viaUser, unknownTotal: unknownUsers.length, totalVisits: totalVisitsAgg._sum.count ?? 0, unknown, topVisits };
  })

  // Affiliate detail: the users it brought, with valid (paid) status.
  .get("/affiliates/:id", async ({ params, set }) => {
    const a = await db.affiliate.findUnique({ where: { id: params.id } });
    if (!a) { set.status = 404; return { error: "not_found" }; }
    const users = await db.user.findMany({
      where: { affiliateId: a.id },
      select: { id: true, nickname: true, email: true, username: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    });
    const paid = new Set((await db.topUp.groupBy({ by: ["userId"], where: { userId: { in: users.map((u) => u.id) }, status: "PAID" } })).map((r) => r.userId));
    const spentBy = new Map<string, number>();
    for (const r of await db.topUp.groupBy({ by: ["userId"], where: { userId: { in: users.map((u) => u.id) }, status: "PAID" }, _sum: { amountUsd: true } })) {
      spentBy.set(r.userId, r._sum.amountUsd ?? 0);
    }
    return {
      affiliate: { id: a.id, code: a.code, name: a.name, note: a.note, active: a.active, paidUsdCents: a.paidUsd },
      users: users.map((u) => ({ nickname: u.nickname, email: u.email, username: u.username, createdAt: u.createdAt, valid: paid.has(u.id), spentUsdCents: spentBy.get(u.id) ?? 0 })),
    };
  });
