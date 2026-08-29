-- AlterTable
ALTER TABLE "Customer" ALTER COLUMN "phone" DROP NOT NULL;
ALTER TABLE "Customer" ADD COLUMN "email" TEXT;
ALTER TABLE "Customer" ADD COLUMN "passwordHash" TEXT;
ALTER TABLE "Customer" ADD COLUMN "googleId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Customer_email_key" ON "Customer"("email");
CREATE UNIQUE INDEX "Customer_googleId_key" ON "Customer"("googleId");
