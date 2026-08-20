import { db } from "./db";
import { executeDraw, refundRaffle } from "./lib/draw";

const MAX_EXTENSIONS = 5; // after this many +24h extensions, cancel + refund
const EXTEND_MS = 24 * 60 * 60 * 1000;

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
        await db.raffle.update({
          where: { id: r.id },
          data: { closesAt: new Date(now.getTime() + EXTEND_MS), extensionCount: { increment: 1 } },
        });
        console.log(`⏰ auto-extend +24h ${r.slug} (${count}/${r.minTickets}, extensión ${r.extensionCount + 1})`);
      } else {
        const n = await refundRaffle(r.id);
        console.log(`⏰ auto-cancel ${r.slug} (no llegó al mínimo tras ${MAX_EXTENSIONS} extensiones), reembolsadas ${n} órdenes`);
      }
    } catch (e) {
      console.error(`⏰ scheduler error en ${r.slug}:`, e);
    }
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
