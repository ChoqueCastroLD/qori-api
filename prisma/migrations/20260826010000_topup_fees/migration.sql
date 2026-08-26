-- Payment-processor settlement breakdown (charge-currency minor units)
ALTER TABLE "TopUp" ADD COLUMN "chargeCurrency" TEXT;
ALTER TABLE "TopUp" ADD COLUMN "grossAmount" INTEGER;
ALTER TABLE "TopUp" ADD COLUMN "feeAmount" INTEGER;
ALTER TABLE "TopUp" ADD COLUMN "netAmount" INTEGER;
