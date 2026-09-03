-- Store the raw ?ref used at registration (even unknown codes) for traffic tracking.
ALTER TABLE "User" ADD COLUMN "refCode" TEXT;
CREATE INDEX "User_refCode_idx" ON "User"("refCode");
