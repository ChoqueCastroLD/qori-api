-- Bingo raffle type: card-based, provably-fair ball order, full-card winners.

-- Raffle format discriminator.
CREATE TYPE "RaffleKind" AS ENUM ('SHOW', 'BINGO');
ALTER TABLE "Raffle" ADD COLUMN "kind" "RaffleKind" NOT NULL DEFAULT 'SHOW';

-- Player cards.
CREATE TABLE "BingoCard" (
    "id" TEXT NOT NULL,
    "raffleId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "orderId" TEXT,
    "seq" INTEGER NOT NULL,
    "cols" JSONB NOT NULL,
    "key" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BingoCard_pkey" PRIMARY KEY ("id")
);

-- Winning cards (several rows on a same-ball tie).
CREATE TABLE "BingoWin" (
    "id" TEXT NOT NULL,
    "raffleId" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "userId" TEXT,
    "position" INTEGER NOT NULL DEFAULT 1,
    "shareUsd" INTEGER NOT NULL,
    "claimCode" TEXT,
    "prizeStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "notifiedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BingoWin_pkey" PRIMARY KEY ("id")
);

-- Live draw timeline (ball order + synchronized start).
CREATE TABLE "BingoGame" (
    "id" TEXT NOT NULL,
    "raffleId" TEXT NOT NULL,
    "ballOrder" INTEGER[],
    "intervalSec" INTEGER NOT NULL DEFAULT 18,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BingoGame_pkey" PRIMARY KEY ("id")
);

-- Indexes & uniqueness.
CREATE UNIQUE INDEX "BingoCard_raffleId_key_key" ON "BingoCard"("raffleId", "key");
CREATE UNIQUE INDEX "BingoCard_raffleId_seq_key" ON "BingoCard"("raffleId", "seq");
CREATE INDEX "BingoCard_raffleId_idx" ON "BingoCard"("raffleId");
CREATE INDEX "BingoCard_ownerId_idx" ON "BingoCard"("ownerId");

CREATE UNIQUE INDEX "BingoWin_cardId_key" ON "BingoWin"("cardId");
CREATE UNIQUE INDEX "BingoWin_claimCode_key" ON "BingoWin"("claimCode");
CREATE INDEX "BingoWin_raffleId_idx" ON "BingoWin"("raffleId");
CREATE INDEX "BingoWin_userId_idx" ON "BingoWin"("userId");

CREATE UNIQUE INDEX "BingoGame_raffleId_key" ON "BingoGame"("raffleId");

-- Foreign keys.
ALTER TABLE "BingoCard" ADD CONSTRAINT "BingoCard_raffleId_fkey" FOREIGN KEY ("raffleId") REFERENCES "Raffle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BingoCard" ADD CONSTRAINT "BingoCard_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BingoCard" ADD CONSTRAINT "BingoCard_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "BingoWin" ADD CONSTRAINT "BingoWin_raffleId_fkey" FOREIGN KEY ("raffleId") REFERENCES "Raffle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BingoWin" ADD CONSTRAINT "BingoWin_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "BingoCard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BingoWin" ADD CONSTRAINT "BingoWin_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "BingoGame" ADD CONSTRAINT "BingoGame_raffleId_fkey" FOREIGN KEY ("raffleId") REFERENCES "Raffle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
