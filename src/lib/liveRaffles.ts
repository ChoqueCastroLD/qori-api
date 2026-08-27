// Tiny in-process pub/sub so every open raffle page gets live ticket counts.
// Single backend instance, so an in-memory Set of listeners is enough.
type Listener = (payload: string) => void;
const listeners = new Set<Listener>();

export function subscribeRaffles(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Broadcast a raffle's new sold count to every connected client. */
export function publishSold(slug: string, sold: number, total: number): void {
  const payload = JSON.stringify({ slug, sold, total });
  for (const fn of listeners) {
    try { fn(payload); } catch {}
  }
}
