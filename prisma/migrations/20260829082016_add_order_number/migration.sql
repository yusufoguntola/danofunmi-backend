-- AlterTable
ALTER TABLE "Order" ADD COLUMN "orderNumber" SERIAL NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Order_orderNumber_key" ON "Order"("orderNumber");

-- Restart the backing sequence so new orders read as short, friendly numbers
-- (existing orders keep whatever they were backfilled with, all below 10000).
ALTER SEQUENCE "Order_orderNumber_seq" RESTART WITH 10000;
