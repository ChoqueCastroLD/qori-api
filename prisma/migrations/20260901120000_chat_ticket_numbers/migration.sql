-- Sender ticket numbers on chat messages (for live/dead badge)
ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "ticketNumbers" INTEGER[] NOT NULL DEFAULT ARRAY[]::integer[];
