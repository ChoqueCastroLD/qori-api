import { Elysia } from "elysia";
import { verifyIpn } from "../lib/nowpayments";
import { creditTopupIfPending } from "../lib/topups";

// NOWPayments Instant Payment Notification (IPN). Verifies the HMAC signature,
// then credits the matching top-up once the payment is fully settled.
export const nowpayments = new Elysia({ name: "nowpayments" }).post(
  "/nowpayments/ipn",
  async ({ body, headers, set }) => {
    const sig = (headers["x-nowpayments-sig"] as string | undefined);
    if (!verifyIpn(body, sig)) {
      set.status = 401;
      return { error: "bad_signature" };
    }
    const b = body as any;
    const topupId: string | undefined = b.order_id;
    const status: string | undefined = b.payment_status;
    if (topupId && (status === "finished" || status === "confirmed")) {
      await creditTopupIfPending(topupId, {
        providerRef: String(b.payment_id ?? b.invoice_id ?? ""),
        memoLabel: "Recarga cripto",
      });
    }
    return { ok: true };
  },
);
