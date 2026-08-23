// Live USD exchange rates (cached). Used only for an indicative "aprox S/ X"
// shown next to the real USD price. Source: open.er-api.com (free, no key).
let cache: { rates: Record<string, number>; at: number } | null = null;
const TTL = 12 * 60 * 60 * 1000; // 12h

export async function getRates(): Promise<{ base: string; rates: Record<string, number>; updatedAt: string | null }> {
  if (cache && Date.now() - cache.at < TTL) {
    return { base: "USD", rates: cache.rates, updatedAt: new Date(cache.at).toISOString() };
  }
  try {
    const res = await fetch("https://open.er-api.com/v6/latest/USD");
    const d = (await res.json()) as { result?: string; rates?: Record<string, number> };
    if (d.result === "success" && d.rates) cache = { rates: d.rates, at: Date.now() };
  } catch (e) {
    console.error("fx fetch failed", e);
  }
  return { base: "USD", rates: cache?.rates ?? {}, updatedAt: cache ? new Date(cache.at).toISOString() : null };
}
