import { Elysia, t } from "elysia";
import { db } from "../db";
import { applyLedger, InsufficientFundsError } from "../lib/wallet";
import { publicUser, withUser } from "./auth";
import type { User } from "@prisma/client";
import { createPreference, mpConfigured } from "../lib/mercadopago";
import { createOrder as createPaypalOrder, paypalConfigured } from "../lib/paypal";
import { sendEmail, purchaseEmail } from "../lib/email";
import { uploadObject, extForType, storageConfigured, MAX_UPLOAD_BYTES } from "../lib/storage";
import { publishSold } from "../lib/liveRaffles";
import { logActivity } from "../lib/activity";

// Handles that collide with routes/brand and can't be taken as usernames.
const RESERVED_USERNAMES = new Set([
  "admin", "api", "u", "sorteos", "sorteo", "ganadores", "recargar", "cuenta",
  "entrar", "registro", "verificar", "como-funciona", "legal", "support",
  "soporte", "qori", "null", "undefined", "live", "me", "www", "app",
]);

/** 1 USD = 10 lingotes (fixed). */
const LINGOTES_PER_USD = 10;

// Fixed recharge packages (USD cents → bonus lingotes). Bonuses are a
// limited-time promo enforced server-side (never trust the client).
const PKG_BONUS: Record<number, number> = { 500: 0, 1000: 10, 2000: 20, 5000: 30, 10000: 100, 50000: 500 };
const BONUS_DEADLINE = Date.parse("2026-09-16T04:59:59Z"); // hasta 15-set-2026 (hora Perú)

function requireUser(user: User | null, set: any): user is User {
  if (!user) {
    set.status = 401;
    return false;
  }
  return true;
}

export const me = new Elysia({ name: "me" })
  .use(withUser)
  // --- Profile ---
  .patch(
    "/me/profile",
    async ({ user, body, set }) => {
      if (!requireUser(user, set)) return { error: "unauthenticated" };
      const data: any = {};
      if (body.nickname !== undefined) data.nickname = body.nickname;
      if (body.phone !== undefined) data.phone = body.phone;
      if (body.country !== undefined) data.country = body.country;

      // Username handle: validate, unique, changeable once per 15 days.
      if (body.username !== undefined && body.username.toLowerCase() !== (user.username ?? "")) {
        const uname = body.username.trim().toLowerCase();
        if (!/^[a-z0-9_]{3,20}$/.test(uname)) { set.status = 422; return { error: "username_invalid" }; }
        if (RESERVED_USERNAMES.has(uname)) { set.status = 422; return { error: "username_reserved" }; }
        if (user.usernameChangedAt) {
          const days = (Date.now() - new Date(user.usernameChangedAt).getTime()) / 86400000;
          if (days < 15) { set.status = 429; return { error: "username_cooldown", daysLeft: Math.ceil(15 - days) }; }
        }
        const taken = await db.user.findUnique({ where: { username: uname } });
        if (taken && taken.id !== user.id) { set.status = 409; return { error: "username_taken" }; }
        data.username = uname;
        data.usernameChangedAt = new Date();
      }

      // Avatar change (from URL field) is logged old -> new.
      const avatarChanged = body.avatarUrl !== undefined && body.avatarUrl !== user.avatarUrl;
      if (body.avatarUrl !== undefined) data.avatarUrl = body.avatarUrl;

      const updated = await db.user.update({ where: { id: user.id }, data });
      if (data.username) await logActivity(user.id, "username_change", { from: user.username ?? null, to: data.username });
      if (avatarChanged) await logActivity(user.id, "avatar_change", { to: updated.avatarUrl });
      return { user: publicUser(updated) };
    },
    {
      body: t.Object({
        nickname: t.Optional(t.String({ maxLength: 40 })),
        username: t.Optional(t.String({ maxLength: 20 })),
        avatarUrl: t.Optional(t.String({ maxLength: 500 })),
        phone: t.Optional(t.String({ maxLength: 30 })),
        country: t.Optional(t.String({ minLength: 2, maxLength: 2 })),
      }),
    },
  )

  // --- Avatar upload (R2) ---
  .post(
    "/me/avatar",
    async ({ user, body, set }) => {
      if (!requireUser(user, set)) return { error: "unauthenticated" };
      if (!storageConfigured()) { set.status = 503; return { error: "storage_not_configured" }; }
      const file = body.file as File;
      const ext = extForType(file.type);
      if (!ext) { set.status = 415; return { error: "unsupported_type" }; }
      if (file.size > MAX_UPLOAD_BYTES) { set.status = 413; return { error: "too_large" }; }
      try {
        const key = `avatars/${user.id}/${crypto.randomUUID()}.${ext}`;
        const url = await uploadObject(key, await file.arrayBuffer(), file.type);
        const updated = await db.user.update({ where: { id: user.id }, data: { avatarUrl: url } });
        await logActivity(user.id, "avatar_change", { to: url });
        return { url, user: publicUser(updated) };
      } catch (e) {
        set.status = 502;
        return { error: "upload_failed" };
      }
    },
    { body: t.Object({ file: t.File() }) },
  )

  // --- Public profile (view-only, money censored) ---
  // Returns a user's public handle + a transparency feed: which raffles they
  // bought tickets in (raffle, quantity, date) and profile changes (username /
  // avatar). No balances, amounts, email or edit options are ever exposed here.
  .get("/u/:username", async ({ params, set }) => {
    const u = await db.user.findUnique({ where: { username: params.username.toLowerCase() } });
    if (!u) { set.status = 404; return { error: "not_found" }; }
    const [ticketsTotal, winsCount, orders, activities] = await Promise.all([
      db.ticket.count({ where: { ownerId: u.id } }),
      db.winner.count({ where: { userId: u.id } }),
      db.order.findMany({
        where: { userId: u.id, status: "CONFIRMED" },
        include: { raffle: { select: { slug: true, title: true, images: true } } },
        orderBy: { createdAt: "desc" }, take: 60,
      }),
      db.activity.findMany({ where: { userId: u.id }, orderBy: { createdAt: "desc" }, take: 60 }),
    ]);
    const feed = [
      ...orders.map((o) => ({
        type: "purchase" as const, at: o.createdAt, quantity: o.quantity,
        raffle: { slug: o.raffle.slug, title: o.raffle.title, image: o.raffle.images?.[0] ?? null },
      })),
      ...activities.map((a) => ({ type: a.type as string, at: a.createdAt, data: a.data as any })),
    ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()).slice(0, 80);
    return {
      profile: {
        username: u.username, nickname: u.nickname, avatarUrl: u.avatarUrl,
        country: u.country, createdAt: u.createdAt, ticketsTotal, winsCount,
      },
      feed,
    };
  })

  // --- Wallet: ledger history + balance ---
  .get("/me/wallet", async ({ user, set }) => {
    if (!requireUser(user, set)) return { error: "unauthenticated" };
    const entries = await db.ledgerEntry.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return { balance: user.balance, entries };
  })

  // --- Referrals ---
  .get("/me/referrals", async ({ user, set }) => {
    if (!requireUser(user, set)) return { error: "unauthenticated" };
    const referred = await db.user.findMany({
      where: { referredById: user.id },
      select: { nickname: true, createdAt: true, referralRewarded: true },
      orderBy: { createdAt: "desc" },
    });
    const earned = await db.ledgerEntry.aggregate({
      where: { userId: user.id, type: "REFERRAL" },
      _sum: { amount: true },
    });
    return {
      code: user.referralCode,
      count: referred.length,
      lingotesEarned: earned._sum.amount ?? 0,
      referred,
    };
  })

  // --- My tickets & orders ---
  .get("/me/tickets", async ({ user, set }) => {
    if (!requireUser(user, set)) return { error: "unauthenticated" };
    const tickets = await db.ticket.findMany({
      where: { ownerId: user.id },
      include: { raffle: { select: { slug: true, title: true, status: true, images: true } }, win: true },
      orderBy: { createdAt: "desc" },
    });
    return { tickets };
  })

  .get("/me/orders", async ({ user, set }) => {
    if (!requireUser(user, set)) return { error: "unauthenticated" };
    const orders = await db.order.findMany({
      where: { userId: user.id },
      include: { raffle: { select: { slug: true, title: true } }, tickets: { select: { number: true } } },
      orderBy: { createdAt: "desc" },
    });
    return { orders };
  })

  // --- Buy tickets (spend lingotes) ---
  .post(
    "/raffles/:slug/buy",
    async ({ user, params, body, set }) => {
      if (!requireUser(user, set)) return { error: "unauthenticated" };
      const quantity = body.quantity;

      // Count every attempt (even failures) for admin visibility.
      void db.user.update({ where: { id: user.id }, data: { buyAttempts: { increment: 1 } } }).catch(() => {});
      if (user.canBuy === false) { set.status = 403; return { error: "buy_disabled" }; }

      try {
        const result = await db.$transaction(async (tx) => {
          // Lock the raffle row to serialize ticket assignment per raffle.
          const raffle = await tx.raffle.findUnique({ where: { slug: params.slug } });
          if (!raffle) throw new Error("raffle_not_found");
          if (raffle.blocked) throw new Error("raffle_blocked");
          if (raffle.status !== "OPEN") throw new Error("raffle_not_open");
          await tx.raffle.update({ where: { id: raffle.id }, data: { updatedAt: new Date() } });

          const sold = await tx.ticket.count({ where: { raffleId: raffle.id } });
          if (sold + quantity > raffle.totalTickets) throw new Error("sold_out");

          if (raffle.maxTicketsPerUser) {
            const mine = await tx.ticket.count({ where: { raffleId: raffle.id, ownerId: user.id } });
            if (mine + quantity > raffle.maxTicketsPerUser) throw new Error("per_user_limit");
          }

          const cost = raffle.ticketPrice * quantity;

          // Deduct lingotes (throws InsufficientFundsError if not enough).
          await applyLedger(tx, {
            userId: user.id,
            amount: -cost,
            type: "TICKET_SPEND",
            refType: "raffle",
            refId: raffle.id,
            memo: `${quantity} ticket(s) de ${raffle.title}`,
          });

          const order = await tx.order.create({
            data: {
              raffleId: raffle.id,
              userId: user.id,
              quantity,
              costLingotes: cost,
              bonusLingotes: quantity,
            },
          });

          // Assign unique RANDOM numbers not yet taken.
          const taken = new Set(
            (await tx.ticket.findMany({ where: { raffleId: raffle.id }, select: { number: true } })).map(
              (t) => t.number,
            ),
          );
          // Build the list of still-available numbers, then pick `quantity` of
          // them with a partial Fisher-Yates shuffle. Rejection sampling used to
          // fail (could_not_assign) when buying a large fraction of the raffle —
          // collecting N unique numbers out of N by random retries needs
          // ~N·ln(N) tries, blowing past any fixed guard.
          const available: number[] = [];
          for (let n = 1; n <= raffle.totalTickets; n++) if (!taken.has(n)) available.push(n);
          if (available.length < quantity) throw new Error("sold_out");
          for (let i = 0; i < quantity; i++) {
            const j = i + Math.floor(Math.random() * (available.length - i));
            [available[i], available[j]] = [available[j], available[i]];
          }
          const chosen: number[] = available.slice(0, quantity);

          await tx.ticket.createMany({
            data: chosen.map((number) => ({
              raffleId: raffle.id,
              number,
              orderId: order.id,
              ownerId: user.id,
              comment: body.comment ?? null,
            })),
          });

          // +1 lingote bonus per ticket.
          await applyLedger(tx, {
            userId: user.id,
            amount: quantity,
            type: "TICKET_BONUS",
            refType: "order",
            refId: order.id,
            memo: `Bono +${quantity} por compra`,
          });

          // Referral reward: +10 to referrer on the referred user's FIRST purchase.
          const fresh = await tx.user.findUnique({ where: { id: user.id } });
          if (fresh?.referredById && !fresh.referralRewarded) {
            await applyLedger(tx, {
              userId: fresh.referredById,
              amount: 10,
              type: "REFERRAL",
              refType: "user",
              refId: user.id,
              memo: "Referido hizo su primera compra",
            });
            await tx.user.update({ where: { id: user.id }, data: { referralRewarded: true } });
          }

          const owned = await tx.ticket.count({ where: { raffleId: raffle.id, ownerId: user.id } });
          return { orderId: order.id, numbers: chosen.sort((a, b) => a - b), raffleTitle: raffle.title, slug: raffle.slug, sold: sold + quantity, total: raffle.totalTickets, owned, maxPerUser: raffle.maxTicketsPerUser };
        });

        // Broadcast the new sold count to everyone watching this raffle (live).
        publishSold(result.slug, result.sold, result.total);

        // Purchase confirmation email (non-blocking).
        if (user.email) {
          const { subject, html } = purchaseEmail(result.raffleTitle, result.numbers, result.slug);
          void sendEmail({ to: user.email, subject, html }).catch(() => {});
        }

        return { ok: true, orderId: result.orderId, numbers: result.numbers };
      } catch (e: any) {
        if (e instanceof InsufficientFundsError) {
          set.status = 402;
          return { error: "insufficient_funds" };
        }
        const known = [
          "raffle_not_found",
          "raffle_not_open",
          "raffle_blocked",
          "buy_disabled",
          "sold_out",
          "per_user_limit",
          "could_not_assign",
        ];
        if (known.includes(e?.message)) {
          set.status = e.message === "raffle_not_found" ? 404 : 422;
          return { error: e.message };
        }
        set.status = 500;
        return { error: "buy_failed" };
      }
    },
    {
      params: t.Object({ slug: t.String() }),
      body: t.Object({
        quantity: t.Integer({ minimum: 1, maximum: 1000 }),
        comment: t.Optional(t.String({ maxLength: 140 })),
      }),
    },
  )

  // --- Top-ups (recharge lingotes with real money) ---
  .post(
    "/topups",
    async ({ user, body, set }) => {
      if (!requireUser(user, set)) return { error: "unauthenticated" };
      // Only allow the fixed packages.
      const bonus = PKG_BONUS[body.amountUsd];
      if (bonus === undefined) {
        set.status = 422;
        return { error: "invalid_package" };
      }
      const base = Math.round((body.amountUsd / 100) * LINGOTES_PER_USD);
      const lingotes = base + (Date.now() < BONUS_DEADLINE ? bonus : 0);
      const topup = await db.topUp.create({
        data: {
          userId: user.id,
          amountUsd: body.amountUsd,
          lingotes,
          method: body.method as any,
          status: "PENDING",
        },
      });
      // Automated methods return a hosted checkout URL.
      if (body.method === "MERCADOPAGO") {
        if (!mpConfigured()) {
          set.status = 503;
          return { error: "mp_not_configured", topup };
        }
        try {
          const pref = await createPreference({ topupId: topup.id, amountUsd: topup.amountUsd, lingotes });
          await db.topUp.update({ where: { id: topup.id }, data: { providerRef: pref.id } });
          return { topup, checkoutUrl: pref.url };
        } catch (e) {
          console.error("mp preference error", e);
          set.status = 502;
          return { error: "mp_error", topup };
        }
      }
      if (body.method === "PAYPAL") {
        if (!paypalConfigured()) {
          set.status = 503;
          return { error: "paypal_not_configured", topup };
        }
        try {
          const order = await createPaypalOrder({ topupId: topup.id, amountUsd: topup.amountUsd });
          await db.topUp.update({ where: { id: topup.id }, data: { providerRef: order.id } });
          return { topup, checkoutUrl: order.url };
        } catch (e) {
          console.error("paypal order error", e);
          set.status = 502;
          return { error: "paypal_error", topup };
        }
      }
      return { topup };
    },
    {
      body: t.Object({
        amountUsd: t.Integer({ minimum: 100 }), // min $1
        method: t.Union([t.Literal("MERCADOPAGO"), t.Literal("PAYPAL")]),
      }),
    },
  )

  .post(
    "/topups/:id/proof",
    async ({ user, params, body, set }) => {
      if (!requireUser(user, set)) return { error: "unauthenticated" };
      const topup = await db.topUp.findUnique({ where: { id: params.id } });
      if (!topup || topup.userId !== user.id) {
        set.status = 404;
        return { error: "not_found" };
      }
      const updated = await db.topUp.update({
        where: { id: params.id },
        data: { proofUrl: body.proofUrl },
      });
      return { topup: updated };
    },
    { body: t.Object({ proofUrl: t.String({ maxLength: 500 }) }) },
  )

  .get("/topups/mine", async ({ user, set }) => {
    if (!requireUser(user, set)) return { error: "unauthenticated" };
    const topups = await db.topUp.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
    });
    return { topups };
  });
