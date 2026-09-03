-- Unique visits per referral code (clicks that may not convert to registration).
CREATE TABLE "RefVisit" (
    "code" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RefVisit_pkey" PRIMARY KEY ("code")
);
