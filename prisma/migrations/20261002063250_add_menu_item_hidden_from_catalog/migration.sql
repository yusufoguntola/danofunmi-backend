-- AlterTable
ALTER TABLE "MenuItem" ADD COLUMN     "hiddenFromCatalog" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: preserve today's effective visibility. Every item previously
-- hidden en masse via the whole "Promotions" category (see lib/menuCatalog.js
-- HIDDEN_CATEGORIES, being removed by this change in favor of this per-item
-- flag) stays hidden until an admin explicitly opts it back in.
UPDATE "MenuItem" mi
SET "hiddenFromCatalog" = true
FROM "MenuCategory" mc
WHERE mi."categoryId" = mc.id AND mc.name = 'Promotions';
