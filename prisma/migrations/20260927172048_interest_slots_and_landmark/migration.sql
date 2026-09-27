-- AlterTable
ALTER TABLE "InterestRegistration" ADD COLUMN     "claimedSlot" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "landmark" TEXT;

-- CreateTable
CREATE TABLE "LaunchSettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "firstTasteSlots" INTEGER NOT NULL DEFAULT 20,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LaunchSettings_pkey" PRIMARY KEY ("id")
);
