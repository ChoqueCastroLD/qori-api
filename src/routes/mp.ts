import { Elysia } from "elysia";
import { db } from "../db";
import { applyLedger } from "../lib/wallet";
import { getPayment } from "../lib/mercadopago";
import { sendEmail, topupApprovedEmail } from "../lib/email";

export const mp = new Elysia({ name: "mp" })
  // MercadoPago payment notifications. Always 200 so MP doesn't retry forever.
  .post("/mp/webhook", async ({ body, query, set }) => {
    try {
      const b: any = body ?? {};
      const type = b.type || b.topic || (query as any).type || (query as any).topic;
      const paymentId = b?.data?.id || (query as any)["data.id"] || (query as any).id;
      if (type && String(type) !== "payment") { set.status = 200; return { ok: true, ignored: type }; }
      if (!paymentId) { set.status = 200; return { ok: true, no_id: true }; }

      // Confirm the real payment status with MercadoPago (don't trust the ping).
      const payment = await getPayment(String(paymentId));
      if (!payment || payment.status !== "approved" || !payment.external_reference) {
        set.status = 200;
        return { ok: true, status: payment?.status ?? "unknown" };
      }

      const topupId = payment.external_reference;
      // Idempotent credit: only if still pending.
      await db.$transaction(async (tx) => {
        const topup = await tx.topUp.findUnique({ where: { id: topupId } });
        if (!topup || topup.status === "PAID") return;
        await applyLedger(tx, {
          userId: topup.userId,
          amount: topup.lingotes,
          type: "TOPUP",
          refType: "topup",
          refId: topup.id,
          memo: `Recarga MercadoPago $${(topup.amountUsd / 100).toFixed(2)}`,
        });
        await tx.topUp.update({
          where: { id: topup.id },
          data: { status: "PAID", confirmedAt: new Date(), providerRef: String(paymentId) },
        });
      });

      // Notify the user (outside the tx, non-blocking).
      const topup = await db.topUp.findUnique({ where: { id: topupId }, include: { user: { select: { email: true } } } });
      if (topup?.status === "PAID" && topup.user?.email && topup.providerRef === String(paymentId)) {
        const { subject, html } = topupApprovedEmail(topup.lingotes, topup.amountUsd);
        void sendEmail({ to: topup.user.email, subject, html }).catch(() => {});
      }

      set.status = 200;
      return { ok: true };
    } catch (e) {
      console.error("mp webhook error", e);
      set.status = 200; // avoid infinite retries; we logged it
      return { ok: false };
    }
  });
