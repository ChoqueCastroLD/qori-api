-- Public username handle + change timestamp
ALTER TABLE "User" ADD COLUMN "username" TEXT;
ALTER TABLE "User" ADD COLUMN "usernameChangedAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- Public activity log
CREATE TABLE "Activity" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "data" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Activity_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Activity_userId_createdAt_idx" ON "Activity"("userId", "createdAt");
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
