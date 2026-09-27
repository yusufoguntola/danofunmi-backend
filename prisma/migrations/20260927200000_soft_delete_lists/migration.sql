-- AlterTable
ALTER TABLE "InterestRegistration" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ExtraneousRequest" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Feedback" ADD COLUMN     "deletedAt" TIMESTAMP(3);
