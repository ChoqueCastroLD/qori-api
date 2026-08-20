// Non-destructive refresh: set all raffles to the 5 phases, regenerate the show
// for drawn raffles (winners are unchanged - they're picked before games in the
// RNG stream), and add demo chat messages where missing. No deletes.
import { PrismaClient } from "@prisma/client";
import { hmacSha256Hex } from "../src/fair";
import { generateShow, type GameType } from "../src/show";

const db = new PrismaClient();
const ALL: GameType[] = ["ELIMINATION", "DIGIT_REVEAL", "SQUID", "HORSE_RACE", "BOMBS"];
const FINALE: GameType = "BOMBS";
const LINES = ["¡Vamos que se puede! 🍀", "suerte a todos", "qué nervios 😰", "compré 5 boletos 🔥", "provably-fair FTW", "🤞🤞", "las bombas al final 💣", "vamoo"];

async function main() {
  const users = await db.user.findMany({ where: { email: { endsWith: "@demo.qori.cc" } } });
  const raffles = await db.raffle.findMany();
  for (const r of raffles) {
    await db.raffle.update({ where: { id: r.id }, data: { games: ALL, finale: FINALE } });

    if (r.status === "DRAWN" && r.serverSeed && r.drandValue && r.ticketsRoot) {
      const tickets = await db.ticket.findMany({ where: { raffleId: r.id }, orderBy: { number: "asc" } });
      const publicEntropy = `${r.drandRound}:${r.drandValue}:${r.ticketsRoot}`;
      const digest = await hmacSha256Hex(r.serverSeed, publicEntropy);
      const show = generateShow({ digest, ticketCount: tickets.length, winnersCount: r.winnersCount, games: ALL, finale: FINALE });
      // Winners are unchanged; just refresh the staged show.
      await db.drawShow.update({ where: { raffleId: r.id }, data: { stages: show as any } }).catch(async () => {
        await db.drawShow.create({ data: { raffleId: r.id, stages: show as any, startsAt: new Date(), endsAt: new Date() } });
      });
      console.log(`  ${r.slug}: show regenerado (${show.stages.length} fases), ganadores ${show.winners.map((i) => tickets[i].number).join(",")}`);
    }

    const chatCount = await db.chatMessage.count({ where: { raffleId: r.id } });
    if (chatCount === 0 && users.length) {
      for (let i = 0; i < 8; i++) {
        const u = users[Math.floor(Math.random() * users.length)];
        await db.chatMessage.create({ data: { raffleId: r.id, userId: u.id, nickname: u.nickname ?? "demo", avatarUrl: u.avatarUrl, text: LINES[Math.floor(Math.random() * LINES.length)] } });
      }
    }
  }
  console.log("✅ refresh completo");
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => db.$disconnect());
