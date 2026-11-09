-- CreateTable
CREATE TABLE "ProcessorTransaction" (
    "id" TEXT NOT NULL,
    "processorChargeId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessorTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProcessorTransaction_processorChargeId_key" ON "ProcessorTransaction"("processorChargeId");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessorTransaction_idempotencyKey_key" ON "ProcessorTransaction"("idempotencyKey");
