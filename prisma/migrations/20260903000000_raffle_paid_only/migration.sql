-- Exclusive raffles: only real-money spenders can enter.
ALTER TABLE "Raffle" ADD COLUMN "paidOnly" BOOLEAN NOT NULL DEFAULT false;
