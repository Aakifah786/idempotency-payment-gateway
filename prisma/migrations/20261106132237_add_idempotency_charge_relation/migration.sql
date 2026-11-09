-- AddForeignKey
ALTER TABLE "Charge" ADD CONSTRAINT "Charge_idempotencyKey_fkey" FOREIGN KEY ("idempotencyKey") REFERENCES "IdempotencyKey"("key") ON DELETE RESTRICT ON UPDATE CASCADE;
