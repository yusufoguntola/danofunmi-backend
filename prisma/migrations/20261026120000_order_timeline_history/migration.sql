-- OrderTimeline goes from a single edited-in-place row to an append-only
-- history: each admin save inserts a new row, and the newest is current.

-- New rows get a cuid from Prisma Client; the old 'singleton' id stays as-is.
ALTER TABLE "OrderTimeline" ALTER COLUMN "id" DROP DEFAULT;

ALTER TABLE "OrderTimeline" ADD COLUMN "createdByName" TEXT,
ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- The existing row was last saved at its updatedAt, which becomes its place
-- in the history.
UPDATE "OrderTimeline" SET "createdAt" = "updatedAt";

ALTER TABLE "OrderTimeline" DROP COLUMN "updatedAt";

-- CreateIndex
CREATE INDEX "OrderTimeline_createdAt_idx" ON "OrderTimeline"("createdAt");
