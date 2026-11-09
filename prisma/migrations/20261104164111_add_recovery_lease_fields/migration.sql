-- AlterTable
ALTER TABLE "IdempotencyKey" ADD COLUMN     "recoveryStartedAt" TIMESTAMP(3),
ADD COLUMN     "recoveryToken" TEXT;
