// Additive, idempotent production seed — inserts demo data only if empty.
// Contains no destructive operations.
import { PrismaClient } from "@prisma/client";
import { seedData } from "../src/lib/seedData";

const db = new PrismaClient();
seedData(db)
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => db.$disconnect());
