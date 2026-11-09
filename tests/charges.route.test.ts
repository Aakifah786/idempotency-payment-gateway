import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { prisma } from "../src/prismaClient.js";
import { createApp } from "../src/server.js";
import { FakeProcessor } from "../src/processor.js";

beforeEach(async () => {
  await prisma.charge.deleteMany();
  await prisma.idempotencyKey.deleteMany();
  await prisma.processorTransaction.deleteMany();
});

describe("POST /charges", () => {
  it("requires an Idempotency-Key header", async () => {
    const app = createApp();
    const res = await request(app).post("/charges").send({ amount: 500, currency: "usd", customerId: "cus_1" });

    expect(res.status).toBe(400);
  });
  it("rejects a whitespace-only Idempotency-Key", async () => {
    const app = createApp();
    const res = await request(app)
    .post("/charges")
    .set("Idempotency-Key", "   ")
    .send({ amount: 500, currency: "usd", customerId: "cus_1" });

  expect(res.status).toBe(400);
  expect(res.body.error).toBe("Idempotency-Key header is required");
});
  it("validates the request body", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/charges")
      .set("Idempotency-Key", "k1")
      .send({ amount: -5, currency: "usd", customerId: "cus_1" });

    expect(res.status).toBe(400);
  });
    it("rejects decimal amounts", async () => {
      const app = createApp();

      const res = await request(app)
        .post("/charges")
        .set("Idempotency-Key", "decimal-amount-test")
        .send({ amount: 500.5, currency: "usd", customerId: "cus_1" });

      expect(res.status).toBe(400);
});
  it("rejects invalid currency formats", async () => {
  const app = createApp();

  const res = await request(app)
    .post("/charges")
    .set("Idempotency-Key", "invalid-currency-test")
    .send({ amount: 500, currency: "123", customerId: "cus_1" });

  expect(res.status).toBe(400);
});
  it("charges once and replays the same response on retry", async () => {
    const processor = new FakeProcessor();
    const app = createApp(processor);
    const payload = { amount: 1500, currency: "usd", customerId: "cus_42" };

    const first = await request(app).post("/charges").set("Idempotency-Key", "k-route-1").send(payload);
    expect(first.status).toBe(201);
    expect(first.headers["idempotent-replayed"]).toBe("false");

    const second = await request(app).post("/charges").set("Idempotency-Key", "k-route-1").send(payload);
    expect(second.status).toBe(201);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(second.body).toEqual(first.body);

    expect(processor.callCount).toBe(1);

    const charges = await prisma.charge.findMany({ where: { idempotencyKey: "k-route-1" } });
    expect(charges).toHaveLength(1);
  });
    it("normalizes lowercase currency to uppercase", async () => {
  const app = createApp();

  const res = await request(app)
    .post("/charges")
    .set("Idempotency-Key", "lowercase-currency-test")
    .send({ amount: 500, currency: "usd", customerId: "cus_1" });

  expect(res.status).toBe(201);
  expect(res.body.currency).toBe("USD");
});

  it("rejects the same key reused with a different payload", async () => {
    const app = createApp();

    await request(app)
      .post("/charges")
      .set("Idempotency-Key", "k-conflict")
      .send({ amount: 1000, currency: "usd", customerId: "cus_1" });

    const res = await request(app)
      .post("/charges")
      .set("Idempotency-Key", "k-conflict")
      .send({ amount: 2000, currency: "usd", customerId: "cus_1" });

    expect(res.status).toBe(422);
  });

  it("charges exactly once under real concurrent duplicate requests", async () => {
    const processor = new FakeProcessor();
    const app = createApp(processor);
    const payload = { amount: 750, currency: "usd", customerId: "cus_race" };

    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        request(app).post("/charges").set("Idempotency-Key", "k-race").send(payload),
      ),
    );

    expect(processor.callCount).toBe(1);
    for (const res of responses) {
      expect(res.status).toBe(201);
      expect(res.body.id).toBe(responses[0].body.id);
    }

    const charges = await prisma.charge.findMany({ where: { idempotencyKey: "k-race" } });
    expect(charges).toHaveLength(1);
  });
     it("successfully recovers when the existing charge matches the processor charge", async () => {
  const processor = new FakeProcessor();
  const app = createApp(processor);

  const key = "recovery-matching-charge-test";
  const payload = {
    amount: 750,
    currency: "USD",
    customerId: "cus_recovery",
  };

  // Simulate a payment that succeeded at the processor.
  const processorCharge = await processor.charge({
    ...payload,
    idempotencyKey: key,
  });

  // Generate the same request hash used by the idempotency system.
  const requestHash = createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");

  // Create a stale processing record to trigger recovery.
  await prisma.idempotencyKey.create({
    data: {
      key,
      requestHash,
      status: "processing",
      processingStartedAt: new Date(Date.now() - 3 * 60 * 1000),
      processingToken: "old-processing-token",
    },
  });

  // Simulate a charge recorprisma.charge.created that was already saved correctly.
  await prisma.charge.create({
  data: {
    idempotencyKey: key,
    processorChargeId: processorCharge.id,
    amount: processorCharge.amount,
    currency: processorCharge.currency,
    customerId: processorCharge.customerId,
    status: processorCharge.status,
  },
});

  const response = await request(app)
    .post("/charges")
    .set("Idempotency-Key", key)
    .send(payload);

  expect(response.status).toBe(201);
  expect(response.headers["idempotent-replayed"]).toBe("true");
  expect(response.body.processorChargeId).toBe(processorCharge.id);

  const savedCharges = await prisma.charge.findMany({
    where: { idempotencyKey: key },
  });

  expect(savedCharges).toHaveLength(1);

  const finalRecord = await prisma.idempotencyKey.findUnique({
    where: { key },
  });

  expect(finalRecord?.status).toBe("completed");
  expect(finalRecord?.processingToken).toBeNull();
  expect(finalRecord?.recoveryToken).toBeNull();
});
it("rejects recovery when the existing charge does not match the processor charge", async () => {
  const processor = new FakeProcessor();
  const app = createApp(processor);

  const key = "recovery-mismatching-charge-test";
  const payload = {
    amount: 750,
    currency: "USD",
    customerId: "cus_recovery",
  };

  // Simulate a successful payment at the processor.
  const processorCharge = await processor.charge({
    ...payload,
    idempotencyKey: key,
  });

  const requestHash = createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");

  // Create a stale processing record to trigger recovery.
  await prisma.idempotencyKey.create({
    data: {
      key,
      requestHash,
      status: "processing",
      processingStartedAt: new Date(Date.now() - 3 * 60 * 1000),
      processingToken: "old-processing-token",
    },
  });

  // Deliberately create an inconsistent database charge.
  await prisma.charge.create({
    data: {
      idempotencyKey: key,
      processorChargeId: processorCharge.id,
      amount: 999,
      currency: processorCharge.currency,
      customerId: processorCharge.customerId,
      status: processorCharge.status,
    },
  });

  const response = await request(app)
    .post("/charges")
    .set("Idempotency-Key", key)
    .send(payload);

  expect(response.status).toBe(500);
  expect(response.body.error).toBe("Internal error processing charge");

  // Confirm that the inconsistent record was not silently overwritten.
  const savedCharge = await prisma.charge.findUnique({
    where: { idempotencyKey: key },
  });

  expect(savedCharge?.amount).toBe(999);

  // Recovery must remain unresolved for investigation.
  const finalRecord = await prisma.idempotencyKey.findUnique({
    where: { key },
  });

  expect(finalRecord?.status).toBe("recovering");
  expect(finalRecord?.recoveryToken).not.toBeNull();
});
it("recovers a payment when the processor commits it but loses the response", async () => {
  const processor = new FakeProcessor({
    simulateOutcomeUnknownAfterCommit: true,
  });

  const app = createApp(processor);

  const key = "ambiguous-payment-recovery-test";
  const payload = {
    amount: 1200,
    currency: "USD",
    customerId: "cus_ambiguous",
  };

  // First request: processor saves the payment but loses its response.
  const firstResponse = await request(app)
    .post("/charges")
    .set("Idempotency-Key", key)
    .send(payload);

  expect(firstResponse.status).toBe(503);
  expect(firstResponse.body.code).toBe(
  "PROCESSOR_OUTCOME_UNKNOWN",
);

expect(firstResponse.body.error).toBe(
  "Payment outcome could not be confirmed",
);

  // Confirm that the processor actually committed the payment.
  const processorTransactions =
    await prisma.processorTransaction.findMany({
      where: { idempotencyKey: key },
    });

  expect(processorTransactions).toHaveLength(1);
  expect(processor.callCount).toBe(1);

  // The gateway must not have saved its Charge record yet.
  const chargesBeforeRecovery = await prisma.charge.findMany({
    where: { idempotencyKey: key },
  });

  expect(chargesBeforeRecovery).toHaveLength(0);

  // Simulate the original processing attempt becoming stale.
  await prisma.idempotencyKey.update({
    where: { key },
    data: {
      processingStartedAt: new Date(Date.now() - 3 * 60 * 1000),
    },
  });

  // Second request: gateway should recover the original payment.
  const secondResponse = await request(app)
    .post("/charges")
    .set("Idempotency-Key", key)
    .send(payload);

  expect(secondResponse.status).toBe(201);
  expect(secondResponse.headers["idempotent-replayed"]).toBe("true");

  // Processor must not charge again.
  expect(processor.callCount).toBe(1);

  const finalTransactions = await prisma.processorTransaction.findMany({
    where: { idempotencyKey: key },
  });

  expect(finalTransactions).toHaveLength(1);
  expect(secondResponse.body.processorChargeId).toBe(
  finalTransactions[0].processorChargeId,
);


  // Gateway should now have exactly one Charge record.
  const finalCharges = await prisma.charge.findMany({
    where: { idempotencyKey: key },
  });

  expect(finalCharges).toHaveLength(1);

  expect(finalCharges[0].processorChargeId).toBe(
    finalTransactions[0].processorChargeId,
  );

  const finalRecord = await prisma.idempotencyKey.findUnique({
    where: { key },
  });

  expect(finalRecord?.status).toBe("completed");
  expect(finalRecord?.responseStatus).toBe(201);
  expect(finalRecord?.recoveryToken).toBeNull();
  expect(finalRecord?.recoveryStartedAt).toBeNull();
});
it("recovers a payment after a database error occurs following processor commit", async () => {
  const processor = new FakeProcessor({
    simulateDatabaseErrorAfterCommit: true,
  });

  const app = createApp(processor);

  const key = "database-error-after-commit-test";
  const payload = {
    amount: 1500,
    currency: "INR",
    customerId: "cus_db_error",
  };

  // First request: transaction commits, then a database error occurs.
  const firstResponse = await request(app)
    .post("/charges")
    .set("Idempotency-Key", key)
    .send(payload);

  expect(firstResponse.status).toBe(503);
  expect(firstResponse.body.code).toBe("PROCESSOR_OUTCOME_UNKNOWN");

  // Processor transaction must already exist.
  const transactionsBeforeRecovery =
    await prisma.processorTransaction.findMany({
      where: { idempotencyKey: key },
    });

  expect(transactionsBeforeRecovery).toHaveLength(1);
  expect(processor.callCount).toBe(1);

  // Gateway Charge must not exist yet.
  const chargesBeforeRecovery = await prisma.charge.findMany({
    where: { idempotencyKey: key },
  });

  expect(chargesBeforeRecovery).toHaveLength(0);

  // Make the original processing attempt stale.
  await prisma.idempotencyKey.update({
    where: { key },
    data: {
      processingStartedAt: new Date(Date.now() - 3 * 60 * 1000),
    },
  });

  // Retry using the same key to recover the original payment.
  const secondResponse = await request(app)
    .post("/charges")
    .set("Idempotency-Key", key)
    .send(payload);

  expect(secondResponse.status).toBe(201);
  expect(secondResponse.headers["idempotent-replayed"]).toBe("true");
  expect(processor.callCount).toBe(1);

  const finalTransactions = await prisma.processorTransaction.findMany({
    where: { idempotencyKey: key },
  });

  const finalCharges = await prisma.charge.findMany({
    where: { idempotencyKey: key },
  });

  expect(finalTransactions).toHaveLength(1);
  expect(finalCharges).toHaveLength(1);

  expect(finalCharges[0].processorChargeId).toBe(
    finalTransactions[0].processorChargeId,
  );

  expect(secondResponse.body.processorChargeId).toBe(
    finalTransactions[0].processorChargeId,
  );

  const finalRecord = await prisma.idempotencyKey.findUnique({
    where: { key },
  });

  expect(finalRecord?.status).toBe("completed");
  expect(finalRecord?.responseStatus).toBe(201);
  expect(finalRecord?.recoveryToken).toBeNull();
  expect(finalRecord?.recoveryStartedAt).toBeNull();
});
it("rejects JSON request bodies larger than 10 KB", async () => {
  const processor = new FakeProcessor();
  const app = createApp(processor);

  const oversizedPayload = {
    amount: 500,
    currency: "USD",
    customerId: "cus_oversized",
    extraData: "x".repeat(11 * 1024),
  };

  const response = await request(app)
    .post("/charges")
    .set("Idempotency-Key", "oversized-body-test")
    .send(oversizedPayload);

  expect(response.status).toBe(413);
  expect(processor.callCount).toBe(0);

  const charges = await prisma.charge.findMany({
    where: { idempotencyKey: "oversized-body-test" },
  });

  expect(charges).toHaveLength(0);
});
it("returns a safe retry response when payment persistence fails", async () => {
  const processor = new FakeProcessor();
  const app = createApp(processor);

  const key = "payment-persistence-error-test";

  const response = await request(app)
    .post("/charges")
    .set("Idempotency-Key", key)
    .send({
      amount: 1200,
      currency: "INR",
      customerId: "cus_persistence_error",
    });

  expect(response.status).toBe(201);
});
it("returns a safe retry response when gateway charge persistence fails", async () => {
  const processor = new FakeProcessor();
  const app = createApp(processor);

  const key = "payment-persistence-error-test";

  const createSpy = vi
    .spyOn(prisma.charge, "create")
    .mockRejectedValue(new Error("Simulated gateway database failure"));

  try {
    const response = await request(app)
      .post("/charges")
      .set("Idempotency-Key", key)
      .send({
        amount: 1200,
        currency: "INR",
        customerId: "cus_persistence_error",
      });

    expect(response.status).toBe(503);

    expect(response.body.code).toBe("PAYMENT_PERSISTENCE_FAILED");

    expect(response.body.message).toContain(
      "Retry using the same Idempotency-Key",
    );

    // Processor payment must have succeeded.
    expect(processor.callCount).toBe(1);

    const transactions = await prisma.processorTransaction.findMany({
      where: { idempotencyKey: key },
    });

    expect(transactions).toHaveLength(1);

    // Gateway Charge must not have been saved.
    const charges = await prisma.charge.findMany({
      where: { idempotencyKey: key },
    });

    expect(charges).toHaveLength(0);
  } finally {
    createSpy.mockRestore();
  }
});
it("returns healthy status when the server is running", async () => {
  const app = createApp();

  const response = await request(app).get("/health");

  expect(response.status).toBe(200);
  expect(response.body).toEqual({ ok: true });
});

it("returns ready status when the database is reachable", async () => {
  const app = createApp();

  const response = await request(app).get("/ready");

  expect(response.status).toBe(200);
  expect(response.body).toEqual({ ready: true });
});
});
