-- AlterTable
ALTER TABLE "InterestRegistration" ADD COLUMN     "orderId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "InterestRegistration_orderId_key" ON "InterestRegistration"("orderId");
