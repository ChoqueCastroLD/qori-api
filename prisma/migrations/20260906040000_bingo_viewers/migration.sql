-- Distinct viewers of a bingo room (live "watching now" + historical total).
CREATE TABLE "BingoViewer" (
    "id" TEXT NOT NULL,
    "raffleId" TEXT NOT NULL,
    "viewerKey" TEXT NOT NULL,
    "firstSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BingoViewer_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BingoViewer_raffleId_viewerKey_key" ON "BingoViewer"("raffleId", "viewerKey");
CREATE INDEX "BingoViewer_raffleId_idx" ON "BingoViewer"("raffleId");
CREATE INDEX "BingoViewer_lastSeen_idx" ON "BingoViewer"("lastSeen");

ALTER TABLE "BingoViewer" ADD CONSTRAINT "BingoViewer_raffleId_fkey" FOREIGN KEY ("raffleId") REFERENCES "Raffle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
