// NOWPayments crypto gateway (hosted invoice → IPN callback → auto-credit).
// Charges in USD; the payer picks USDT/BTC/etc. Non-custodial settlement to the
// merchant wallet configured in the NOWPayments dashboard.
import crypto from "crypto";

const API_KEY = process.env.NOWPAYMENTS_API_KEY ?? "";
const IPN_SECRET = process.env.NOWPAYMENTS_IPN_SECRET ?? "";
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "https://qori.cc";
const API = "https://api.nowpayments.io/v1";

export function nowpaymentsConfigured(): boolean {
  return !!API_KEY;
}

export async function createInvoice(t: { topupId: string; amountUsd: number }): Promise<{ id: string; url: string }> {
  const res = await fetch(`${API}/invoice`, {
    method: "POST",
    headers: { "x-api-key": API_KEY, "content-type": "application/json" },
    body: JSON.stringify({
      price_amount: t.amountUsd / 100,
      price_currency: "usd",
      order_id: t.topupId,
      order_description: "Recarga de lingotes qori.cc",
      ipn_callback_url: `${WEB_ORIGIN}/api/nowpayments/ipn`,
      success_url: `${WEB_ORIGIN}/recargar?crypto=success`,
      cancel_url: `${WEB_ORIGIN}/recargar?crypto=cancel`,
    }),
  });
  if (!res.ok) throw new Error(`nowpayments invoice ${res.status} ${await res.text().catch(() => "")}`);
  const d = (await res.json()) as any;
  return { id: String(d.id), url: d.invoice_url };
}

// NOWPayments signs the IPN body with HMAC-SHA512 over the JSON with TOP-LEVEL
// keys sorted alphabetically (mirrors their ksort + json_encode; JS does not
// escape slashes, matching JSON_UNESCAPED_SLASHES).
export function verifyIpn(body: any, signature: string | undefined): boolean {
  if (!IPN_SECRET || !signature || !body || typeof body !== "object") return false;
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(body).sort()) sorted[k] = body[k];
  const hmac = crypto.createHmac("sha512", IPN_SECRET).update(JSON.stringify(sorted)).digest("hex");
  const a = Buffer.from(hmac);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
