-- Order numbers are now app-generated random 6-digit ints (see
-- backend/src/lib/orderNumber.js), not a Postgres sequence — drop the
-- SERIAL default and its backing sequence.
ALTER TABLE "Order" ALTER COLUMN "orderNumber" DROP DEFAULT;
DROP SEQUENCE IF EXISTS "Order_orderNumber_seq";
