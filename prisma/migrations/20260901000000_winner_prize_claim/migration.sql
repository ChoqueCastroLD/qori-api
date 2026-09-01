-- Prize claim code + status on Winner
ALTER TABLE "Winner" ADD COLUMN IF NOT EXISTS "claimCode" TEXT;
ALTER TABLE "Winner" ADD COLUMN IF NOT EXISTS "prizeStatus" TEXT NOT NULL DEFAULT 'PENDING';
ALTER TABLE "Winner" ADD COLUMN IF NOT EXISTS "notifiedAt" TIMESTAMP(3);
ALTER TABLE "Winner" ADD COLUMN IF NOT EXISTS "deliveredAt" TIMESTAMP(3);
CREATE UNIQUE INDEX IF NOT EXISTS "Winner_claimCode_key" ON "Winner"("claimCode");
