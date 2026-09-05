-- Configurable seconds between balls in a BINGO draw (null = default 18).
ALTER TABLE "Raffle" ADD COLUMN "bingoIntervalSec" INTEGER;
