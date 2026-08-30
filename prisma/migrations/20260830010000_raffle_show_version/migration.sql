-- Show algorithm version (null/1 = legacy, 2 = per-game sims)
ALTER TABLE "Raffle" ADD COLUMN IF NOT EXISTS "showVersion" INTEGER;
