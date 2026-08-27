import { Elysia, t } from "elysia";
import { db } from "../db";
import { applyLedger, InsufficientFundsError } from "../lib/wallet";
import { publicUser, withUser } from "./auth";
import type { User } from "@prisma/client";
import { createPreference, mpConfigured } from "../lib/mercadopago";
import { createOrder as createPaypalOrder, paypalConfigured } from "../lib/paypal";
import { sendEmail, purchaseEmail } from "../lib/email";
import { uploadObject, extForType, storageConfigured, MAX_UPLOAD_BYTES } from "../lib/storage";

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
      const updated = await db.user.update({
        where: { id: user.id },
        data: {
          nickname: body.nickname ?? undefined,
          avatarUrl: body.avatarUrl ?? undefined,
          phone: body.phone ?? undefined,
          country: body.country ?? undefined,
        },
      });
      return { user: publicUser(updated) };
    },
    {
      body: t.Object({
        nickname: t.Optional(t.String({ maxLength: 40 })),
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
        return { url, user: publicUser(updated) };
      } catch (e) {
        set.status = 502;
        return { error: "upload_failed" };
      }
    },
    { body: t.Object({ file: t.File() }) },
  )

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
          const chosen: number[] = [];
          let guard = 0;
          while (chosen.length < quantity && guard < raffle.totalTickets * 4) {
            guard++;
            const n = 1 + Math.floor(Math.random() * raffle.totalTickets);
            if (!taken.has(n)) {
              taken.add(n);
              chosen.push(n);
            }
          }
          if (chosen.length < quantity) throw new Error("could_not_assign");

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

          return { orderId: order.id, numbers: chosen.sort((a, b) => a - b), raffleTitle: raffle.title, slug: raffle.slug };
        });

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
