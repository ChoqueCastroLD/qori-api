-- Admin block switch for raffles
ALTER TABLE "Raffle" ADD COLUMN "blocked" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Raffle" ADD COLUMN "blockReason" TEXT;
ALTER TABLE "Raffle" ADD COLUMN "blockHistory" JSONB;
