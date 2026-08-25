import { Elysia, t } from "elysia";
import { captureOrder } from "../lib/paypal";
import { creditTopupIfPending } from "../lib/topups";

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
        await creditTopupIfPending(cap.topupId, { providerRef: orderId, memoLabel: "Recarga PayPal" });
        return go("success");
      } catch (e) {
        console.error("paypal return error", e);
        return go("failure");
      }
    },
    { query: t.Object({ token: t.Optional(t.String()), PayerID: t.Optional(t.String()) }) },
  );
