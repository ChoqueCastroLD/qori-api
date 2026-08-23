import { Elysia, t } from "elysia";
import { db } from "../db";
import { applyLedger } from "../lib/wallet";
import { captureOrder } from "../lib/paypal";
import { sendEmail, topupApprovedEmail } from "../lib/email";

const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "https://qori.cc";

export const paypal = new Elysia({ name: "paypal" })
  // PayPal redirects here after approval (?token=<orderId>). We capture + credit.
  .get(
    "/paypal/return",
    async ({ query, set }) => {
      const orderId = query.token;
      const go = (r: string) => { set.status = 302; set.headers.location = `${WEB_ORIGIN}/recargar?pp=${r}`; };
      if (!orderId) return go("failure");
      try {
        const cap = await captureOrder(orderId);
        if (!cap.completed || !cap.topupId) return go("failure");

        await db.$transaction(async (tx) => {
          const topup = await tx.topUp.findUnique({ where: { id: cap.topupId! } });
          if (!topup || topup.status === "PAID") return;
          await applyLedger(tx, {
            userId: topup.userId,
            amount: topup.lingotes,
            type: "TOPUP",
            refType: "topup",
            refId: topup.id,
            memo: `Recarga PayPal $${(topup.amountUsd / 100).toFixed(2)}`,
          });
          await tx.topUp.update({ where: { id: topup.id }, data: { status: "PAID", confirmedAt: new Date(), providerRef: orderId } });
        });

        const topup = await db.topUp.findUnique({ where: { id: cap.topupId }, include: { user: { select: { email: true } } } });
        if (topup?.status === "PAID" && topup.user?.email) {
          const { subject, html } = topupApprovedEmail(topup.lingotes, topup.amountUsd);
          void sendEmail({ to: topup.user.email, subject, html }).catch(() => {});
        }
        return go("success");
      } catch (e) {
        console.error("paypal return error", e);
        return go("failure");
      }
    },
    { query: t.Object({ token: t.Optional(t.String()), PayerID: t.Optional(t.String()) }) },
  );
