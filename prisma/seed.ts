// DEV seed: wipes qori tables then inserts demo data. DEV ONLY.
import { PrismaClient } from "@prisma/client";
import { seedData } from "../src/lib/seedData";

const db = new PrismaClient();

async function main() {
  console.log("🧹 Limpiando (dev)...");
  await db.winner.deleteMany();
  await db.drawShow.deleteMany();
  await db.ticket.deleteMany();
  await db.order.deleteMany();
  await db.ledgerEntry.deleteMany();
  await db.topUp.deleteMany();
  await db.raffle.deleteMany();
  await db.oAuthAccount.deleteMany();
  await db.session.deleteMany();
  await db.user.deleteMany();
  await seedData(db);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => db.$disconnect());
