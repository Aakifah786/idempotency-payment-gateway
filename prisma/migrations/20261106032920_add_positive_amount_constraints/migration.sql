-- Ensure charge amounts are always positive.
ALTER TABLE "Charge"
ADD CONSTRAINT "Charge_amount_positive_check"
CHECK ("amount" > 0);

-- Ensure processor transaction amounts are always positive.
ALTER TABLE "ProcessorTransaction"
ADD CONSTRAINT "ProcessorTransaction_amount_positive_check"
CHECK ("amount" > 0);