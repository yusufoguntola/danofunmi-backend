-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "statusUpdatedAt" TIMESTAMP(3);

-- Backfill existing rows with the best available proxy for "when status last
-- changed" — the relevant per-status timestamp where one exists, falling
-- back to updatedAt (most pre-existing writes to Order were status changes)
-- and finally createdAt for a row that's never been touched at all.
UPDATE "Order"
SET "statusUpdatedAt" = COALESCE("cancelledAt", "deliveredAt", "outForDeliveryAt", "packedAt", "updatedAt", "createdAt");
