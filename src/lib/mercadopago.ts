// MercadoPago Checkout Pro integration. Charges in the account's local currency
// (PEN for a Peru account); our topups are in USD, so we convert.
import { getRates } from "./fx";

const MP_TOKEN = process.env.MP_ACCESS_TOKEN ?? "";
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "https://qori.cc";
const CURRENCY = process.env.MP_CURRENCY ?? "PEN";
const FALLBACK_RATE = Number(process.env.MP_USD_RATE ?? 3.75); // USD → local (fallback)

export function mpConfigured(): boolean {
  return !!MP_TOKEN;
}

/** Live USD→account-currency rate, falling back to the env value if FX is down. */
async function usdRate(): Promise<number> {
  try {
    const { rates } = await getRates();
    const r = rates[CURRENCY];
    if (r && r > 0) return r;
  } catch {}
  return FALLBACK_RATE;
}

/** Create a Checkout Pro preference; returns the hosted checkout URL. */
export async function createPreference(t: {
  topupId: string;
  amountUsd: number; // cents
  lingotes: number;
}): Promise<{ id: string; url: string }> {
  const rate = await usdRate();
  const unitPrice = Math.round((t.amountUsd / 100) * rate * 100) / 100;
  const res = await fetch("https://api.mercadopago.com/checkout/preferences", {
    method: "POST",
    headers: { authorization: `Bearer ${MP_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({
      items: [
        {
          title: `${t.lingotes} lingotes - qori`,
          description: "Recarga de lingotes en qori.cc",
          quantity: 1,
          unit_price: unitPrice,
          currency_id: CURRENCY,
        },
      ],
      external_reference: t.topupId,
      back_urls: {
        success: `${WEB_ORIGIN}/recargar?mp=success`,
        failure: `${WEB_ORIGIN}/recargar?mp=failure`,
        pending: `${WEB_ORIGIN}/recargar?mp=pending`,
      },
      auto_return: "approved",
      notification_url: `${WEB_ORIGIN}/api/mp/webhook`,
      statement_descriptor: "QORI",
    }),
  });
  if (!res.ok) throw new Error(`mp_preference_failed ${res.status}: ${await res.text().catch(() => "")}`);
  const d = (await res.json()) as { id: string; init_point: string };
  return { id: d.id, url: d.init_point };
}

/** Fetch a payment to confirm its real status (never trust the webhook blindly). */
export async function getPayment(id: string): Promise<{
  status: string;
  external_reference?: string;
} | null> {
  const res = await fetch(`https://api.mercadopago.com/v1/payments/${id}`, {
    headers: { authorization: `Bearer ${MP_TOKEN}` },
  });
  if (!res.ok) return null;
  return res.json();
}

/** Find an approved payment by our external_reference (for reconciliation). */
export async function searchApprovedPayment(externalRef: string): Promise<{ id: string } | null> {
  const res = await fetch(
    `https://api.mercadopago.com/v1/payments/search?external_reference=${encodeURIComponent(externalRef)}&status=approved`,
    { headers: { authorization: `Bearer ${MP_TOKEN}` } },
  );
  if (!res.ok) return null;
  const d = (await res.json()) as { results?: { id: number }[] };
  const p = d.results?.[0];
  return p ? { id: String(p.id) } : null;
}
