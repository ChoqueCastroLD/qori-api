// Load historical (legacy) raffles from prisma/legacy.json as DRAWN + legacy.
// Idempotent: skips a raffle whose slug already exists. No deletes.
import { PrismaClient } from "@prisma/client";
import raffles from "./legacy.json";

const db = new PrismaClient();

async function main() {
  for (const r of raffles as any[]) {
    const exists = await db.raffle.findUnique({ where: { slug: r.slug } });
    if (exists) {
      console.log(`- ${r.slug} ya existe, salto`);
      continue;
    }
    const raffle = await db.raffle.create({
      data: {
        slug: r.slug,
        title: r.title,
        description: r.description || "Sorteo histórico realizado manualmente.",
        images: [`/legacy/${r.slug}.png`],
        prizeValue: r.prizeUsdCents ?? 0,
        ticketPrice: r.ticketPriceLingotes ?? 0,
        totalTickets: r.totalTickets ?? 1,
        minTickets: 1,
        winnersCount: r.winnersCount ?? 1,
        games: [],
        finale: null,
        legacy: true,
        status: "DRAWN",
        commitment: "",
        entropySource: "Sorteo histórico (realizado manualmente antes de la plataforma)",
        opensAt: new Date(r.createdAt),
        closesAt: new Date(r.drawnAt),
        drawnAt: new Date(r.drawnAt),
      },
    });
    // Winner ticket + Winner row (no platform user; store the display name).
    const ticket = await db.ticket.create({
      data: { raffleId: raffle.id, number: r.winnerTicket || 1, ownerId: null },
    });
    await db.winner.create({
      data: { raffleId: raffle.id, ticketId: ticket.id, userId: null, name: r.winnerName, position: 1 },
    });
    // Prevent the scheduler from emailing about these historical raffles.
    for (const kind of ["results", "closing-1h"]) {
      await db.notificationLog.create({ data: { raffleId: raffle.id, kind } }).catch(() => {});
    }
    console.log(`OK ${r.slug} cargado (ganador ${r.winnerName} #${r.winnerTicket})`);
  }
  console.log("Legacy cargado");
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => db.$disconnect());
