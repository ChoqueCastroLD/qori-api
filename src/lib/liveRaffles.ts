// In-process registry of open WebSocket clients for live ticket counts.
// Single backend instance, so a Set is enough. (SSE was buffered by the proxy
// chain, so we push over WebSocket instead.)
const sockets = new Set<{ send: (data: string) => void }>();

export function addSocket(ws: { send: (data: string) => void }): void {
  sockets.add(ws);
}
export function removeSocket(ws: { send: (data: string) => void }): void {
  sockets.delete(ws);
}

/** Broadcast a raffle's new sold count to every connected client. */
export function publishSold(slug: string, sold: number, total: number): void {
  const payload = JSON.stringify({ slug, sold, total });
  for (const ws of sockets) {
    try { ws.send(payload); } catch {}
  }
}
