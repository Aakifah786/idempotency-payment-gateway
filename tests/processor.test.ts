import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "../src/prismaClient.js";
import { FakeProcessor } from "../src/processor.js";

describe("FakeProcessor", () => {
    beforeEach(async () => {
    await prisma.processorTransaction.deleteMany();
  });
  it("processes simultaneous duplicate calls only once", async () => {
    const processor = new FakeProcessor();

    const input = {
      amount: 750,
      currency: "USD",
      customerId: "cus_concurrent",
      idempotencyKey: "processor-race-test",
    };

    const results = await Promise.all(
      Array.from({ length: 10 }, () => processor.charge(input)),
    );

    expect(processor.callCount).toBe(1);

    for (const result of results) {
      expect(result.id).toBe(results[0].id);
    }
  });
  it("rejects invalid inputs before starting processor work and allows a valid retry", async () => {
  const processor = new FakeProcessor();

  const invalidInput = {
    amount: -750,
    currency: "USD",
    customerId: "cus_retry",
    idempotencyKey: "processor-retry-test",
  };

  const failedResults = await Promise.allSettled(
    Array.from({ length: 10 }, () => processor.charge(invalidInput)),
  );

  expect(processor.callCount).toBe(0);

  for (const result of failedResults) {
    expect(result.status).toBe("rejected");
  }

  const validResult = await processor.charge({
    ...invalidInput,
    amount: 750,
  });

  expect(processor.callCount).toBe(1);
  expect(validResult.amount).toBe(750);
  expect(validResult.status).toBe("succeeded");
});
     it("replays an existing payment across processor instances", async () => {
  const firstProcessor = new FakeProcessor();

  const input = {
    amount: 900,
    currency: "USD",
    customerId: "cus_restart",
    idempotencyKey: "processor-restart-test",
  };

  const firstResult = await firstProcessor.charge(input);

  expect(firstProcessor.callCount).toBe(1);

  // Simulate a new processor instance after an application restart.
  const secondProcessor = new FakeProcessor();

  const secondResult = await secondProcessor.charge(input);

  expect(secondResult).toEqual(firstResult);
  expect(secondProcessor.callCount).toBe(0);

  const transactions = await prisma.processorTransaction.findMany({
    where: { idempotencyKey: input.idempotencyKey },
  });

  expect(transactions).toHaveLength(1);
});
it("rejects reuse of an idempotency key with different payment details", async () => {
  const processor = new FakeProcessor();

  const originalInput = {
    amount: 900,
    currency: "USD",
    customerId: "cus_key_mismatch",
    idempotencyKey: "processor-key-mismatch-test",
  };

  const originalResult = await processor.charge(originalInput);

  expect(originalResult.amount).toBe(900);
  expect(processor.callCount).toBe(1);

  await expect(
    processor.charge({
      ...originalInput,
      amount: 1500,
    }),
  ).rejects.toThrow(
    "Processor idempotency key reused with different payment details",
  );

  expect(processor.callCount).toBe(1);

  const transactions = await prisma.processorTransaction.findMany({
    where: { idempotencyKey: originalInput.idempotencyKey },
  });

  expect(transactions).toHaveLength(1);
  expect(transactions[0].amount).toBe(900);
});
it("prevents duplicate payments across concurrent processor instances", async () => {
  const firstProcessor = new FakeProcessor();
  const secondProcessor = new FakeProcessor();

  const input = {
    amount: 1800,
    currency: "USD",
    customerId: "cus_cross_instance",
    idempotencyKey: "processor-cross-instance-race-test",
  };

  const results = await Promise.all([
    firstProcessor.charge(input),
    secondProcessor.charge(input),
  ]);

  expect(results[0].id).toBe(results[1].id);

  expect(
    firstProcessor.callCount + secondProcessor.callCount,
  ).toBe(2);

  const transactions = await prisma.processorTransaction.findMany({
    where: { idempotencyKey: input.idempotencyKey },
  });

  expect(transactions).toHaveLength(1);
});
it("rejects concurrent requests with the same key but different payment details", async () => {
  const firstProcessor = new FakeProcessor();
  const secondProcessor = new FakeProcessor();

  const firstInput = {
    amount: 900,
    currency: "USD",
    customerId: "cus_concurrent_mismatch",
    idempotencyKey: "processor-concurrent-mismatch-test",
  };

  const secondInput = {
    ...firstInput,
    amount: 1500,
  };

  const results = await Promise.allSettled([
    firstProcessor.charge(firstInput),
    secondProcessor.charge(secondInput),
  ]);

  const fulfilled = results.filter(
    (result) => result.status === "fulfilled",
  );

  const rejected = results.filter(
    (result) => result.status === "rejected",
  );

  expect(fulfilled).toHaveLength(1);
  expect(rejected).toHaveLength(1);

  const transactions = await prisma.processorTransaction.findMany({
    where: {
      idempotencyKey: firstInput.idempotencyKey,
    },
  });

  expect(transactions).toHaveLength(1);

  expect([900, 1500]).toContain(transactions[0].amount);
});
it("rejects unsupported currencies", async () => {
  const processor = new FakeProcessor();

  await expect(
    processor.charge({
      amount: 900,
      currency: "GBP",
      customerId: "cus_invalid_currency",
      idempotencyKey: "processor-invalid-currency-test",
    }),
  ).rejects.toThrow("Unsupported currency");

  const transactions = await prisma.processorTransaction.findMany({
    where: {
      idempotencyKey: "processor-invalid-currency-test",
    },
  });

  expect(transactions).toHaveLength(0);
});
it("rejects empty or whitespace-only customer IDs", async () => {
  const processor = new FakeProcessor();

  await expect(
    processor.charge({
      amount: 900,
      currency: "USD",
      customerId: "   ",
      idempotencyKey: "processor-empty-customer-test",
    }),
  ).rejects.toThrow("Customer ID is required");

  const transactions = await prisma.processorTransaction.findMany({
    where: {
      idempotencyKey: "processor-empty-customer-test",
    },
  });

  expect(transactions).toHaveLength(0);
});
it("normalizes currency and customer ID before saving a payment", async () => {
  const processor = new FakeProcessor();

  const result = await processor.charge({
    amount: 900,
    currency: " usd ",
    customerId: " cus_normalized ",
    idempotencyKey: "processor-normalization-test",
  });

  expect(result.currency).toBe("USD");
  expect(result.customerId).toBe("cus_normalized");

  const transaction = await prisma.processorTransaction.findUnique({
    where: {
      idempotencyKey: "processor-normalization-test",
    },
  });

  expect(transaction?.currency).toBe("USD");
  expect(transaction?.customerId).toBe("cus_normalized");
});
it("rejects malformed runtime inputs before processor execution", async () => {
  const processor = new FakeProcessor();

  await expect(
    processor.charge(null as never),
  ).rejects.toThrow("Invalid payment input");

  await expect(
    processor.charge({
      amount: 900,
      currency: 123 as never,
      customerId: "cus_invalid_runtime",
      idempotencyKey: "processor-invalid-runtime-test",
    }),
  ).rejects.toThrow("Currency must be a string");

  expect(processor.callCount).toBe(0);
});
it("handles a definite processor database failure and allows a retry", async () => {
  const failingProcessor = new FakeProcessor({
    simulateDatabaseFailureBeforeCommit: true,
  });

  const input = {
    amount: 1200,
    currency: "INR",
    customerId: "cus_db_failure",
    idempotencyKey: "processor-db-failure-test",
  };

  await expect(failingProcessor.charge(input)).rejects.toThrow(
    "Simulated processor database failure before commit",
  );

  expect(failingProcessor.callCount).toBe(1);

  const transactionsBeforeRetry =
    await prisma.processorTransaction.findMany({
      where: { idempotencyKey: input.idempotencyKey },
    });

  expect(transactionsBeforeRetry).toHaveLength(0);

  const retryProcessor = new FakeProcessor();
  const retryResult = await retryProcessor.charge(input);

  expect(retryResult.status).toBe("succeeded");
  expect(retryResult.amount).toBe(1200);
  expect(retryProcessor.callCount).toBe(1);

  const transactionsAfterRetry =
    await prisma.processorTransaction.findMany({
      where: { idempotencyKey: input.idempotencyKey },
    });

  expect(transactionsAfterRetry).toHaveLength(1);
});
it("returns an unknown outcome when recovery lookup fails after a duplicate-key conflict", async () => {
  const processor = new FakeProcessor({
    simulateRecoveryLookupFailure: true,
  });

  const input = {
    amount: 1200,
    currency: "INR",
    customerId: "cus_recovery_lookup_failure",
    idempotencyKey: "processor-recovery-lookup-failure-test",
  };

  const createSpy = vi
    .spyOn(prisma.processorTransaction, "create")
    .mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError(
        "Simulated unique constraint conflict",
        {
          code: "P2002",
          clientVersion: "6.19.3",
        },
      ),
    );

  try {
    await expect(processor.charge(input)).rejects.toThrow(
      "Could not verify the existing processor transaction after a duplicate-key conflict",
    );

    expect(processor.callCount).toBe(1);
    expect(createSpy).toHaveBeenCalledTimes(1);

    const transactions = await prisma.processorTransaction.findMany({
      where: { idempotencyKey: input.idempotencyKey },
    });

    expect(transactions).toHaveLength(0);
  } finally {
    createSpy.mockRestore();
  }
});
});