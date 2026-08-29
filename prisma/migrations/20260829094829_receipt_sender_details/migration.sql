-- Payment confirmation can now be either a receipt image OR a typed
-- sender name + bank (see backend/src/routes/orders.js) — imagePath is no
-- longer required.
ALTER TABLE "PaymentReceipt" ALTER COLUMN "imagePath" DROP NOT NULL;
ALTER TABLE "PaymentReceipt" ADD COLUMN "senderName" TEXT;
ALTER TABLE "PaymentReceipt" ADD COLUMN "senderBank" TEXT;
