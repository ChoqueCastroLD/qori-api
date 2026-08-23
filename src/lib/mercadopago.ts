// MercadoPago Checkout Pro integration. Charges in the account's local currency
// (PEN for a Peru account); our topups are in USD, so we convert.
const MP_TOKEN = process.env.MP_ACCESS_TOKEN ?? "";
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "https://qori.cc";
const CURRENCY = process.env.MP_CURRENCY ?? "PEN";
const USD_RATE = Number(process.env.MP_USD_RATE ?? 3.75); // USD → local

export function mpConfigured(): boolean {
  return !!MP_TOKEN;
}

/** Create a Checkout Pro preference; returns the hosted checkout URL. */
export async function createPreference(t: {
  topupId: string;
  amountUsd: number; // cents
  lingotes: number;
}): Promise<{ id: string; url: string }> {
  const unitPrice = Math.round((t.amountUsd / 100) * USD_RATE * 100) / 100;
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
