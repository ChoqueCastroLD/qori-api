-- Admin moderation switches + buy-attempt counter
ALTER TABLE "User" ADD COLUMN "canChat" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "User" ADD COLUMN "canBuy" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "User" ADD COLUMN "buyAttempts" INTEGER NOT NULL DEFAULT 0;
