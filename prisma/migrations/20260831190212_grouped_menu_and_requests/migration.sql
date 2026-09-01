-- CreateEnum
CREATE TYPE "DiscountType" AS ENUM ('PERCENTAGE', 'FLAT');

-- DropForeignKey
ALTER TABLE "OrderItem" DROP CONSTRAINT "OrderItem_menuItemId_fkey";

-- DropForeignKey
ALTER TABLE "OrderItem" DROP CONSTRAINT "OrderItem_menuItemOptionId_fkey";

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "groupSnapshot" JSONB,
ADD COLUMN     "menuGroupId" TEXT,
ALTER COLUMN "menuItemId" DROP NOT NULL,
ALTER COLUMN "menuItemOptionId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "MenuGroup" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "description" TEXT,
    "icon" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "discountType" "DiscountType",
    "discountValue" DECIMAL(10,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MenuGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MenuGroupItem" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "menuItemOptionId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "isBonus" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "MenuGroupItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtraneousRequest" (
    "id" TEXT NOT NULL,
    "requestType" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "customerName" TEXT,
    "customerPhone" TEXT,
    "customerId" TEXT,
    "orderNarration" TEXT,
    "source" "OrderSource" NOT NULL DEFAULT 'WEB_CHAT',
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExtraneousRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MenuGroup_name_key" ON "MenuGroup"("name");

-- AddForeignKey
ALTER TABLE "MenuGroup" ADD CONSTRAINT "MenuGroup_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "MenuCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuGroupItem" ADD CONSTRAINT "MenuGroupItem_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "MenuGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuGroupItem" ADD CONSTRAINT "MenuGroupItem_menuItemOptionId_fkey" FOREIGN KEY ("menuItemOptionId") REFERENCES "MenuItemOption"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_menuItemOptionId_fkey" FOREIGN KEY ("menuItemOptionId") REFERENCES "MenuItemOption"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_menuGroupId_fkey" FOREIGN KEY ("menuGroupId") REFERENCES "MenuGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtraneousRequest" ADD CONSTRAINT "ExtraneousRequest_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
