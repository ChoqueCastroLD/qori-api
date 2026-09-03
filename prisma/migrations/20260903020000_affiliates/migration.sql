-- Affiliate partners (scans/brands) with vanity codes, paid per valid referral.
CREATE TABLE "Affiliate" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "note" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "paidUsd" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Affiliate_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Affiliate_code_key" ON "Affiliate"("code");

ALTER TABLE "User" ADD COLUMN "affiliateId" TEXT;
CREATE INDEX "User_affiliateId_idx" ON "User"("affiliateId");
ALTER TABLE "User" ADD CONSTRAINT "User_affiliateId_fkey" FOREIGN KEY ("affiliateId") REFERENCES "Affiliate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
