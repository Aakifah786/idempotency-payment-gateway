import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "./prismaClient.js";
import { ProcessorOutcomeUnknownError } from "./errors.js";
/**
 * Simulates a payment processor with its own idempotency protection.
 */

export interface ChargeInput {
  amount: number;
  currency: string;
  customerId: string;
  idempotencyKey: string;
}

export interface ChargeResult {
  id: string;
  amount: number;
  currency: string;
  customerId: string;
  status: "succeeded";
}

const LATENCY_MS = 80;
export interface FakeProcessorOptions {
  simulateOutcomeUnknownAfterCommit?: boolean;
  simulateDatabaseFailureBeforeCommit?: boolean;
  simulateDatabaseErrorAfterCommit?: boolean;
  simulateRecoveryLookupFailure?: boolean;
}

export class FakeProcessor {
  callCount = 0;

  private readonly options: FakeProcessorOptions;

  constructor(options: FakeProcessorOptions = {}) {
    this.options = options;
  }

  
  private readonly inFlight = new Map<string, Promise<ChargeResult>>();
  private normalizeAndValidateInput(input: ChargeInput): ChargeInput {
  if (!input || typeof input !== "object") {
    throw new Error("Invalid payment input");
  }

  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw new Error(
      "Amount must be a positive integer (smallest currency unit)",
    );
  }

  if (typeof input.currency !== "string") {
    throw new Error("Currency must be a string");
  }

  const currency = input.currency.trim().toUpperCase();

  const supportedCurrencies = ["INR", "USD", "EUR"];

  if (!supportedCurrencies.includes(currency)) {
    throw new Error("Unsupported currency");
  }

  if (typeof input.customerId !== "string") {
    throw new Error("Customer ID is required");
  }

  const customerId = input.customerId.trim();

  if (customerId === "") {
    throw new Error("Customer ID is required");
  }

  if (
    typeof input.idempotencyKey !== "string" ||
    input.idempotencyKey.trim() === ""
  ) {
    throw new Error("Idempotency key is required");
  }

  return {
    amount: input.amount,
    currency,
    customerId,
    idempotencyKey: input.idempotencyKey.trim(),
  };
}

  async findChargeByIdempotencyKey(
  idempotencyKey: string,
): Promise<ChargeResult | undefined> {
  const transaction = await prisma.processorTransaction.findUnique({
    where: { idempotencyKey },
  });

  if (!transaction) {
    return undefined;
  }

  return {
    id: transaction.processorChargeId,
    amount: transaction.amount,
    currency: transaction.currency,
    customerId: transaction.customerId,
    status: "succeeded",
  };
}

  async charge(input: ChargeInput): Promise<ChargeResult> {
  const normalizedInput = this.normalizeAndValidateInput(input);

  const pending = this.inFlight.get(normalizedInput.idempotencyKey);

  if (pending) {
    const result = await pending;
    this.validateSamePayment(result, normalizedInput);
    return result;
  }

  const operation = this.processChargeWithExistingCheck(normalizedInput);

  this.inFlight.set(normalizedInput.idempotencyKey, operation);

  try {
    return await operation;
  } finally {
    if (this.inFlight.get(normalizedInput.idempotencyKey) === operation) {
      this.inFlight.delete(normalizedInput.idempotencyKey);
    }
  }
}
private async processChargeWithExistingCheck(
  input: ChargeInput,
): Promise<ChargeResult> {
  const existing = await this.findChargeByIdempotencyKey(
    input.idempotencyKey,
  );

  if (existing) {
    this.validateSamePayment(existing, input);
    return existing;
  }

  return this.processCharge(input);
}

  private validateSamePayment(
  existing: ChargeResult,
  input: ChargeInput,
): void {
  if (
    existing.amount !== input.amount ||
    existing.currency !== input.currency ||
    existing.customerId !== input.customerId
  ) {
    throw new Error(
      "Processor idempotency key reused with different payment details",
    );
  }
}
  private async processCharge(
  input: ChargeInput,
): Promise<ChargeResult> {
  this.callCount += 1;

  await new Promise((resolve) => setTimeout(resolve, LATENCY_MS));

  const result: ChargeResult = {
    id: `ch_${randomUUID()}`,
    amount: input.amount,
    currency: input.currency,
    customerId: input.customerId,
    status: "succeeded",
  };
  if (this.options.simulateDatabaseFailureBeforeCommit) {
  throw new Error("Simulated processor database failure before commit");
}

  try {
    await prisma.processorTransaction.create({
      data: {
        processorChargeId: result.id,
        idempotencyKey: input.idempotencyKey,
        amount: result.amount,
        currency: result.currency,
        customerId: result.customerId,
        status: result.status,
      },
    });
    if (this.options.simulateDatabaseErrorAfterCommit) {
  throw new Error("Simulated database error after commit");
}
  } catch (error) {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  ) {
    let existing: ChargeResult | undefined;

    try {
      if (this.options.simulateRecoveryLookupFailure) {
  throw new Error("Simulated processor recovery lookup failure");
}
existing = await this.findChargeByIdempotencyKey(
        input.idempotencyKey,
      );
    } catch {
      throw new ProcessorOutcomeUnknownError(
        "Could not verify the existing processor transaction after a duplicate-key conflict",
      );
    }

    if (existing) {
      this.validateSamePayment(existing, input);
      return existing;
    }

    throw error;
  }

  throw new ProcessorOutcomeUnknownError(
    "Processor transaction persistence outcome could not be confirmed",
  );
}

  // Simulate losing the response after the payment is committed.
  if (this.options.simulateOutcomeUnknownAfterCommit) {
    throw new ProcessorOutcomeUnknownError(
      "Processor committed the payment, but its response was lost",
    );
  }

  return result;
}
}