-- AlterTable
ALTER TABLE "InterestRegistration" ADD COLUMN     "finalEmailSentAt" TIMESTAMP(3),
ADD COLUMN     "shortlisted" BOOLEAN NOT NULL DEFAULT false;
