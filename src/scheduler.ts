import { db } from "./db";
import { executeDraw, refundRaffle } from "./lib/draw";
import { captureOrder } from "./lib/paypal";
import { searchApprovedPayment } from "./lib/mercadopago";
import { creditTopupIfPending } from "./lib/topups";
import { notifyOnce, participants, sendToAll, sendResults, sendPostponed } from "./lib/notify";
import { closingSoonEmail } from "./lib/email";

const MAX_EXTENSIONS = 5; // after this many +24h extensions, cancel + refund
const EXTEND_MS = 24 * 60 * 60 * 1000;

// Catch payments that completed at the provider but never got credited (e.g. the
// user closed the tab before returning, or a webhook was missed).
async function reconcileTopups() {
  const now = Date.now();
  const window = { gt: new Date(now - 3 * 24 * 60 * 60 * 1000), lt: new Date(now - 90 * 1000) };
  const pending = await db.topUp.findMany({
    where: { status: "PENDING", createdAt: window, method: { in: ["PAYPAL", "MERCADOPAGO"] } },
    take: 50,
  });
  for (const t of pending) {
    try {
      if (t.method === "PAYPAL" && t.providerRef) {
        const cap = await captureOrder(t.providerRef);
        if (cap.completed && cap.topupId) await creditTopupIfPending(cap.topupId, { providerRef: t.providerRef, memoLabel: "Recarga PayPal" });
      } else if (t.method === "MERCADOPAGO") {
        const pay = await searchApprovedPayment(t.id);
        if (pay) await creditTopupIfPending(t.id, { providerRef: pay.id, memoLabel: "Recarga MercadoPago" });
      }
    } catch { /* ignore; retried next tick */ }
  }
}

async function tick() {
  const now = new Date();
  const due = await db.raffle.findMany({ where: { status: "OPEN", closesAt: { lte: now } } });
  for (const r of due) {
    try {
      const count = await db.ticket.count({ where: { raffleId: r.id } });
      if (count >= r.minTickets) {
        const res = await executeDraw(r.id);
        if (res) console.log(`⏰ auto-draw ${r.slug} → ganador(es) ${res.winners.map((w) => "#" + w.number).join(", ")}`);
      } else if (r.extensionCount < MAX_EXTENSIONS) {
        // Not enough tickets yet: push the draw 24h to give more time (cuida el profit).
        const to = new Date(now.getTime() + EXTEND_MS);
        const prev = Array.isArray(r.extensions) ? (r.extensions as any[]) : [];
        const entry = { at: now.toISOString(), ticketCount: count, minTickets: r.minTickets, from: r.closesAt, to };
        await db.raffle.update({
          where: { id: r.id },
          data: { closesAt: to, extensionCount: { increment: 1 }, extensions: [...prev, entry] as any },
        });
        console.log(`⏰ auto-extend +24h ${r.slug} (${count}/${r.minTickets}, extensión ${r.extensionCount + 1})`);
        const newDate = to.toLocaleString("es-PE", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
        void sendPostponed(r.id, r.title, r.slug, newDate).catch(() => {});
      } else {
        const n = await refundRaffle(r.id);
        console.log(`⏰ auto-cancel ${r.slug} (no llegó al mínimo tras ${MAX_EXTENSIONS} extensiones), reembolsadas ${n} órdenes`);
      }
    } catch (e) {
      console.error(`⏰ scheduler error en ${r.slug}:`, e);
    }
  }
  await reconcileTopups().catch((e) => console.error("⏰ reconcile error", e));
  await notifyClosingSoon().catch((e) => console.error("⏰ closing-soon error", e));
  await notifyPendingResults().catch((e) => console.error("⏰ results error", e));
}

// "Se sortea pronto" to participants, ~1h before close (once per raffle).
async function notifyClosingSoon() {
  const now = Date.now();
  const soon = await db.raffle.findMany({
    where: { status: "OPEN", closesAt: { gt: new Date(now), lte: new Date(now + 60 * 60 * 1000) } },
  });
  for (const r of soon) {
    await notifyOnce(r.id, "closing-1h", async () => {
      const ps = await participants(r.id);
      await sendToAll(ps.map((p) => p.email), closingSoonEmail(r.title, r.slug));
    });
  }
}

// Winner + "estuviste cerca" emails, a few minutes after the draw (show ended).
async function notifyPendingResults() {
  const cutoff = new Date(Date.now() - 3 * 60 * 1000);
  const drawn = await db.raffle.findMany({ where: { status: "DRAWN", drawnAt: { lte: cutoff } }, take: 20 });
  for (const r of drawn) {
    await notifyOnce(r.id, "results", () => sendResults(r.id));
  }
}

/** Start the background loop that auto-closes/draws/extends raffles by their clock. */
export function startScheduler() {
  if (process.env.DISABLE_SCHEDULER === "1") {
    console.log("⏰ scheduler deshabilitado (DISABLE_SCHEDULER=1)");
    return;
  }
  const iv = Number(process.env.SCHEDULER_INTERVAL_MS ?? 30000);
  console.log(`⏰ scheduler activo (cada ${iv}ms)`);
  setInterval(() => tick().catch((e) => console.error("scheduler tick failed", e)), iv);
  tick().catch(() => {});
}
