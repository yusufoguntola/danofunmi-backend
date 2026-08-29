-- Introduce MenuCategory as a first-class entity, replacing the free-text
-- MenuItem.category column with a categoryId relation. Existing distinct
-- category strings are backfilled into MenuCategory before the column swap.

-- 1. New table
CREATE TABLE "MenuCategory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MenuCategory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MenuCategory_name_key" ON "MenuCategory"("name");

-- 2. Backfill one MenuCategory row per distinct existing MenuItem.category value
INSERT INTO "MenuCategory" ("id", "name")
SELECT gen_random_uuid()::text, "category"
FROM "MenuItem"
GROUP BY "category";

-- 3. Add the new column, backfill it from the old string column, then swap
ALTER TABLE "MenuItem" ADD COLUMN "categoryId" TEXT;

UPDATE "MenuItem" mi
SET "categoryId" = mc."id"
FROM "MenuCategory" mc
WHERE mc."name" = mi."category";

ALTER TABLE "MenuItem" ALTER COLUMN "categoryId" SET NOT NULL;
ALTER TABLE "MenuItem" DROP COLUMN "category";

-- 4. Foreign key + index, matching Prisma's relation conventions
CREATE INDEX "MenuItem_categoryId_idx" ON "MenuItem"("categoryId");

ALTER TABLE "MenuItem" ADD CONSTRAINT "MenuItem_categoryId_fkey"
    FOREIGN KEY ("categoryId") REFERENCES "MenuCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
