// Flow payment gateway (Peru: Yape + cards). Charges in the account currency
// (PEN); our topups are in USD, so we convert. Docs: flow.cl/docs/api.html
import crypto from "crypto";
import { getRates } from "./fx";

const API_KEY = process.env.FLOW_API_KEY ?? "";
const SECRET = process.env.FLOW_SECRET ?? "";
const API_BASE = process.env.FLOW_API_BASE ?? "https://www.flow.cl/api";
const CURRENCY = process.env.FLOW_CURRENCY ?? "PEN";
const FALLBACK_RATE = Number(process.env.FLOW_USD_RATE ?? 3.75);
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "https://qori.cc";

export function flowConfigured(): boolean {
  return !!(API_KEY && SECRET);
}

async function usdRate(): Promise<number> {
  try {
    const { rates } = await getRates();
    const r = rates[CURRENCY];
    if (r && r > 0) return r;
  } catch {}
  return FALLBACK_RATE;
}

// Flow signs requests: params sorted by name, concatenated as name+value (no
// separators), HMAC-SHA256 with the secret key, hex.
function sign(params: Record<string, string>): string {
  const str = Object.keys(params).sort().map((k) => k + params[k]).join("");
  return crypto.createHmac("sha256", SECRET).update(str).digest("hex");
}

export async function createPayment(t: { topupId: string; amountUsd: number; lingotes: number; email: string }): Promise<{ id: string; url: string }> {
  const rate = await usdRate();
  const local = (t.amountUsd / 100) * rate;
  const amount = CURRENCY === "CLP" ? String(Math.round(local)) : (Math.round(local * 100) / 100).toFixed(2);
  const params: Record<string, string> = {
    apiKey: API_KEY,
    commerceOrder: t.topupId,
    subject: `${t.lingotes} lingotes - qori`,
    currency: CURRENCY,
    amount,
    email: t.email,
    urlConfirmation: `${WEB_ORIGIN}/api/flow/confirm`,
    urlReturn: `${WEB_ORIGIN}/api/flow/return`,
  };
  params.s = sign(params);
  const res = await fetch(`${API_BASE}/payment/create`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  if (!res.ok) throw new Error(`flow_create ${res.status}: ${await res.text().catch(() => "")}`);
  const d = (await res.json()) as any;
  return { id: String(d.flowOrder ?? d.token ?? ""), url: `${d.url}?token=${d.token}` };
}

// Confirm the real status (never trust the webhook). status 2 = paid.
export async function getStatus(token: string): Promise<{ status: number; commerceOrder?: string } | null> {
  const params: Record<string, string> = { apiKey: API_KEY, token };
  params.s = sign(params);
  const res = await fetch(`${API_BASE}/payment/getStatus?${new URLSearchParams(params).toString()}`);
  if (!res.ok) return null;
  const d = (await res.json()) as any;
  return { status: Number(d.status), commerceOrder: d.commerceOrder };
}
