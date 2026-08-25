-- AlterTable
ALTER TABLE "Raffle" ADD COLUMN     "legacy" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Winner" ADD COLUMN     "name" TEXT;
