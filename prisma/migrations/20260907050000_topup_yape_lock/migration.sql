-- Manual Yape: locked PEN amount + FX rate + proof deadline.
ALTER TABLE "TopUp" ADD COLUMN "amountPen" INTEGER;
ALTER TABLE "TopUp" ADD COLUMN "fxRate" DOUBLE PRECISION;
ALTER TABLE "TopUp" ADD COLUMN "expiresAt" TIMESTAMP(3);
