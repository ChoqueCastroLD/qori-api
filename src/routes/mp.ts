import { Elysia } from "elysia";
import { getPayment } from "../lib/mercadopago";
import { creditTopupIfPending } from "../lib/topups";

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
      if (payment?.status === "approved" && payment.external_reference) {
        await creditTopupIfPending(payment.external_reference, { providerRef: String(paymentId), memoLabel: "Recarga MercadoPago" });
      }
      set.status = 200;
      return { ok: true, status: payment?.status ?? "unknown" };
    } catch (e) {
      console.error("mp webhook error", e);
      set.status = 200;
      return { ok: false };
    }
  });
