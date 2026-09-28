-- AlterTable
ALTER TABLE "Feedback" ADD COLUMN     "customerName" TEXT,
ADD COLUMN     "foodType" TEXT,
ADD COLUMN     "location" TEXT,
ALTER COLUMN "orderId" DROP NOT NULL;
