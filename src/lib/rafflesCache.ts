// Tiny shared cache for the public raffles list (GET /raffles). Kept in its own
// module so admin mutations can bust it for an instant public update.
export const RAFFLES_TTL_MS = 8000;

let cache: { at: number; data: any } | null = null;

export function getRafflesCache(): any | null {
  if (cache && Date.now() - cache.at < RAFFLES_TTL_MS) return cache.data;
  return null;
}
export function setRafflesCache(data: any): void {
  cache = { at: Date.now(), data };
}
export function bustRafflesCache(): void {
  cache = null;
}
