/*
  Warnings:

  - Changed the type of `status` on the `Charge` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `status` on the `IdempotencyKey` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `status` on the `ProcessorTransaction` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- CreateEnum
CREATE TYPE "IdempotencyStatus" AS ENUM ('processing', 'recovering', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "ChargeStatus" AS ENUM ('succeeded', 'failed');

-- CreateEnum
CREATE TYPE "ProcessorTransactionStatus" AS ENUM ('succeeded', 'failed');

-- AlterTable
ALTER TABLE "Charge" DROP COLUMN "status",
ADD COLUMN     "status" "ChargeStatus" NOT NULL;

-- AlterTable
ALTER TABLE "IdempotencyKey" DROP COLUMN "status",
ADD COLUMN     "status" "IdempotencyStatus" NOT NULL;

-- AlterTable
ALTER TABLE "ProcessorTransaction" DROP COLUMN "status",
ADD COLUMN     "status" "ProcessorTransactionStatus" NOT NULL;
