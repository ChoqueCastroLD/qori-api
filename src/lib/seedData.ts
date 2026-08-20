/**
 * Additive seeder — inserts demo data. Contains NO deletes.
 * Guarded: if raffles already exist it does nothing (idempotent, safe on prod).
 */
import { PrismaClient } from "@prisma/client";
import { createCommitment, hmacSha256Hex, sha256Hex } from "../fair";
import { generateShow, type GameType } from "../show";
import { hashPassword } from "./auth";

const AVATARS = (n: number) => `https://i.pravatar.cc/150?img=${n}`;
const IMG = (seed: string) => `https://picsum.photos/seed/${seed}/900/600`;

export async function seedData(db: PrismaClient) {
  if ((await db.raffle.count()) > 0) {
    console.log("↷ Ya hay sorteos; seed omitido (idempotente).");
    return;
  }
  console.log("🌱 Insertando datos demo...");

  const names = ["Ana", "Beto", "Carla", "Diego", "Elena", "Fabio", "Gaby", "Hugo", "Ivan", "Julia", "Kevin", "Lucia"];
  const users: any[] = [];
  for (let i = 0; i < names.length; i++) {
    const email = `${names[i].toLowerCase()}@demo.qori.cc`;
    const u = await db.user.upsert({
      where: { email },
      update: {},
      create: {
        email, name: names[i], nickname: names[i], avatarUrl: AVATARS(i + 1),
        country: "PE", emailVerified: new Date(), referralCode: `DEMO${1000 + i}`, balance: 0,
      },
    });
    users.push(u);
  }
  await db.user.upsert({
    where: { email: "admin@qori.cc" },
    update: { role: "ADMIN", passwordHash: await hashPassword("qoriadmin123") },
    create: {
      email: "admin@qori.cc", name: "Qori Admin", nickname: "qori", role: "ADMIN",
      passwordHash: await hashPassword("qoriadmin123"), emailVerified: new Date(),
      referralCode: "QORIADMIN", balance: 0,
    },
  });

  for (const u of users) {
    const amt = 200 + Math.floor(Math.random() * 800);
    await db.$transaction(async (tx) => {
      await tx.user.update({ where: { id: u.id }, data: { balance: amt } });
      await tx.ledgerEntry.create({ data: { userId: u.id, amount: amt, balanceAfter: amt, type: "TOPUP", memo: "Recarga inicial (seed)" } });
    });
  }

  async function makeRaffle(opts: {
    slug: string; title: string; description: string; imgSeed: string;
    prizeUsd: number; priceLingotes: number; total: number; min: number;
    games: GameType[]; finale: GameType; winnersCount: number;
    sell: number; closesInHours: number; draw?: boolean;
  }) {
    const { serverSeed, commitment } = await createCommitment();
    const raffle = await db.raffle.create({
      data: {
        slug: opts.slug, title: opts.title, description: opts.description,
        images: [IMG(opts.imgSeed), IMG(opts.imgSeed + "b")],
        prizeValue: opts.prizeUsd * 100, ticketPrice: opts.priceLingotes,
        totalTickets: opts.total, minTickets: opts.min, maxTicketsPerUser: 50,
        winnersCount: opts.winnersCount, games: opts.games, finale: opts.finale,
        entropySource: "drand (round a la hora del sorteo) + raíz de boletos",
        commitment, serverSeed, status: "OPEN", opensAt: new Date(),
        closesAt: new Date(Date.now() + opts.closesInHours * 3600 * 1000),
      },
    });
    const taken = new Set<number>();
    for (let i = 0; i < opts.sell; i++) {
      let n = 0;
      do { n = 1 + Math.floor(Math.random() * opts.total); } while (taken.has(n));
      taken.add(n);
      const u = users[Math.floor(Math.random() * users.length)];
      await db.ticket.create({ data: { raffleId: raffle.id, number: n, ownerId: u.id, comment: Math.random() < 0.3 ? "¡Suerte a todos! 🍀" : null } });
    }
    if (opts.draw) {
      const tickets = await db.ticket.findMany({ where: { raffleId: raffle.id }, orderBy: { number: "asc" } });
      const canonical = tickets.map((t) => `${t.number}:${t.ownerId ?? ""}`).join("|");
      const ticketsRoot = await sha256Hex(canonical);
      const publicEntropy = `1234567:${"a".repeat(64)}:${ticketsRoot}`;
      const digest = await hmacSha256Hex(serverSeed, publicEntropy);
      const show = generateShow({ digest, ticketCount: tickets.length, winnersCount: opts.winnersCount, games: opts.games, finale: opts.finale });
      const winnerTickets = show.winners.map((idx) => tickets[idx]);
      await db.raffle.update({
        where: { id: raffle.id },
        data: { status: "DRAWN", drandRound: BigInt(1234567), drandValue: "a".repeat(64), ticketsRoot, drawDigest: digest, drawnAt: new Date(Date.now() - 3600 * 1000), closesAt: new Date(Date.now() - 7200 * 1000) },
      });
      for (let i = 0; i < winnerTickets.length; i++) {
        await db.winner.create({ data: { raffleId: raffle.id, ticketId: winnerTickets[i].id, userId: winnerTickets[i].ownerId, position: i + 1 } });
      }
      await db.drawShow.create({ data: { raffleId: raffle.id, stages: show as any, startsAt: new Date(Date.now() - 3600 * 1000), endsAt: new Date() } });
    }
    return raffle;
  }

  await makeRaffle({ slug: "iphone-16-pro-max", title: "iPhone 16 Pro Max 256GB", description: "El último iPhone, sellado y con garantía. Sorteo con show en vivo verificable.", imgSeed: "iphone", prizeUsd: 1400, priceLingotes: 20, total: 500, min: 200, games: ["ELIMINATION", "BOMBS", "DIGIT_REVEAL"], finale: "DIGIT_REVEAL", winnersCount: 1, sell: 143, closesInHours: 48 });
  await makeRaffle({ slug: "playstation-5-pro", title: "PlayStation 5 Pro + 2 juegos", description: "Consola PS5 Pro nueva más dos juegos a elección. Entrada en lingotes.", imgSeed: "ps5", prizeUsd: 800, priceLingotes: 10, total: 400, min: 150, games: ["SQUID", "ELIMINATION", "HORSE_RACE"], finale: "HORSE_RACE", winnersCount: 1, sell: 210, closesInHours: 12 });
  await makeRaffle({ slug: "moto-honda-cb190", title: "Moto Honda CB190R 0km", description: "Una moto Honda CB190R cero kilómetros. Tres ganadores de accesorios extra.", imgSeed: "moto", prizeUsd: 3000, priceLingotes: 30, total: 1000, min: 400, games: ["ELIMINATION", "BOMBS", "SQUID", "DIGIT_REVEAL"], finale: "BOMBS", winnersCount: 3, sell: 388, closesInHours: 96 });
  await makeRaffle({ slug: "macbook-air-m3", title: "MacBook Air M3 (finalizado)", description: "Sorteo finalizado y verificable. Semilla revelada.", imgSeed: "macbook", prizeUsd: 1100, priceLingotes: 15, total: 300, min: 100, games: ["ELIMINATION", "DIGIT_REVEAL"], finale: "DIGIT_REVEAL", winnersCount: 1, sell: 300, closesInHours: -2, draw: true });
  await makeRaffle({ slug: "airpods-pro-2", title: "AirPods Pro 2 (finalizado)", description: "Sorteo finalizado. Reproduce el show y verifica el resultado.", imgSeed: "airpods", prizeUsd: 250, priceLingotes: 5, total: 200, min: 80, games: ["BOMBS", "ELIMINATION"], finale: "ELIMINATION", winnersCount: 2, sell: 200, closesInHours: -5, draw: true });

  console.log("✅ Seed completo.");
}
