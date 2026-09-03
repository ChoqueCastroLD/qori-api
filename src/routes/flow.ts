import { Elysia } from "elysia";
import { getStatus } from "../lib/flow";
import { creditTopupIfPending } from "../lib/topups";

const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "https://qori.cc";

export const flow = new Elysia({ name: "flow" })
  // Flow server-to-server confirmation. Flow POSTs the token; we verify the real
  // status and credit if paid (status 2). Always 200 so Flow stops retrying.
  .post("/flow/confirm", async ({ body, set }) => {
    try {
      const token = (body as any)?.token;
      if (token) {
        const st = await getStatus(String(token));
        if (st?.status === 2 && st.commerceOrder) {
          await creditTopupIfPending(st.commerceOrder, { providerRef: String(token), memoLabel: "Recarga Flow", breakdown: st.breakdown });
        }
      }
      set.status = 200; return { ok: true };
    } catch (e) {
      console.error("flow confirm error", e);
      set.status = 200; return { ok: false };
    }
  })
  // Browser return after payment. Crediting happens via /flow/confirm; here we
  // just bounce back to the recharge page.
  .post("/flow/return", ({ set }) => { set.status = 302; set.headers.location = `${WEB_ORIGIN}/recargar?flow=success`; })
  .get("/flow/return", ({ set }) => { set.status = 302; set.headers.location = `${WEB_ORIGIN}/recargar?flow=success`; });
