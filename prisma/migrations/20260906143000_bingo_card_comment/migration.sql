-- Buyer's public note, revealed if the card wins (mirrors Ticket.comment).
ALTER TABLE "BingoCard" ADD COLUMN "comment" TEXT;
