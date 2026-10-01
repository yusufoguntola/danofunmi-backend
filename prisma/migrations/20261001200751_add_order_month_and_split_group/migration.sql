-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "orderMonth" TEXT,
ADD COLUMN     "splitGroupId" TEXT;

-- Backfill existing rows with the same cutoff rule the app uses going
-- forward (lib/orderSchedule.js): an order containing any combo/group line
-- used the 10th-of-the-month cutoff, everything else the 15th; anything
-- submitted after its cutoff rolls into the following month.
UPDATE "Order" o
SET "orderMonth" = to_char(
  CASE WHEN EXTRACT(DAY FROM o."createdAt") > (
    CASE WHEN EXISTS (
      SELECT 1 FROM "OrderItem" oi WHERE oi."orderId" = o.id AND oi."menuGroupId" IS NOT NULL
    ) THEN 10 ELSE 15 END
  )
  THEN o."createdAt" + INTERVAL '1 month'
  ELSE o."createdAt"
  END,
  'YYYY-MM'
);

ALTER TABLE "Order" ALTER COLUMN "orderMonth" SET NOT NULL;

-- CreateIndex
CREATE INDEX "Order_orderMonth_idx" ON "Order"("orderMonth");
