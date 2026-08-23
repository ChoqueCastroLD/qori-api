// PayPal Orders v2 integration (create → approve → capture). Charges in USD.
const CID = process.env.PAYPAL_CLIENT_ID ?? "";
const SECRET = process.env.PAYPAL_SECRET ?? "";
const BASE = (process.env.PAYPAL_ENV ?? "live") === "sandbox"
  ? "https://api-m.sandbox.paypal.com"
  : "https://api-m.paypal.com";
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "https://qori.cc";

export function paypalConfigured(): boolean {
  return !!(CID && SECRET);
}

async function accessToken(): Promise<string> {
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      authorization: "Basic " + Buffer.from(`${CID}:${SECRET}`).toString("base64"),
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`paypal_token_failed ${res.status}`);
  return (await res.json()).access_token as string;
}

/** Create an order; returns the order id and the approval URL to redirect to. */
export async function createOrder(t: { topupId: string; amountUsd: number }): Promise<{ id: string; url: string }> {
  const token = await accessToken();
  const value = (t.amountUsd / 100).toFixed(2);
  const res = await fetch(`${BASE}/v2/checkout/orders`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [
        { custom_id: t.topupId, description: "Recarga de lingotes en qori.cc", amount: { currency_code: "USD", value } },
      ],
      application_context: {
        brand_name: "qori",
        user_action: "PAY_NOW",
        return_url: `${WEB_ORIGIN}/api/paypal/return`,
        cancel_url: `${WEB_ORIGIN}/recargar?pp=cancel`,
      },
    }),
  });
  if (!res.ok) throw new Error(`paypal_create_failed ${res.status}: ${await res.text().catch(() => "")}`);
  const d = (await res.json()) as { id: string; links: { rel: string; href: string }[] };
  const approve = d.links.find((l) => l.rel === "approve" || l.rel === "payer-action");
  if (!approve) throw new Error("paypal_no_approve_link");
  return { id: d.id, url: approve.href };
}

/** Capture an approved order. Returns COMPLETED + the topup id (custom_id). */
export async function captureOrder(orderId: string): Promise<{ completed: boolean; topupId?: string }> {
  const token = await accessToken();
  const res = await fetch(`${BASE}/v2/checkout/orders/${orderId}/capture`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
  const d = await res.json().catch(() => ({}));
  const pu = (d as any)?.purchase_units?.[0];
  const topupId = pu?.custom_id ?? pu?.payments?.captures?.[0]?.custom_id;
  const completed = (d as any)?.status === "COMPLETED";
  return { completed, topupId };
}
