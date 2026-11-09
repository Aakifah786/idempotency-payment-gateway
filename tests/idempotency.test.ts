import { createHash } from "node:crypto" ;
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/prismaClient.js";
import { withIdempotency } from "../src/idempotency.js";
import {
  IdempotencyConflictError,
  ProcessorOutcomeUnknownError,
} from "../src/errors.js";

beforeEach(async () => {
  await prisma.charge.deleteMany();
  await prisma.idempotencyKey.deleteMany();
});

describe("withIdempotency", () => {
  it("runs the handler exactly once, even under real concurrency", async () => {
    let callCount = 0;
    const handler = async () => {
      callCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 50)); // simulate slow work
      return { status: 201, body: { chargedAt: Date.now() } };
    };

    const CONCURRENT_REQUESTS = 20;
    const results = await Promise.all(
      Array.from({ length: CONCURRENT_REQUESTS }, () =>
        withIdempotency(prisma, "key-concurrent", { amount: 500 }, handler),
      ),
    );

    expect(callCount).toBe(1);

    const [first, ...rest] = results;
    for (const result of rest) {
      expect(result.body).toEqual(first.body);
    }
    // Exactly one caller should have actually done the work; every other
    // caller — including concurrent ones — got a replayed result.
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(results.filter((r) => r.replayed)).toHaveLength(CONCURRENT_REQUESTS - 1);

    const rows = await prisma.idempotencyKey.findMany({ where: { key: "key-concurrent" } });
    expect(rows).toHaveLength(1);
  });
    it("records when processing starts", async () => {
      const handler = async () => ({
        status: 201,
        body: { id: "charge-timestamp" },
      });

      await withIdempotency(
        prisma,
        "key-timestamp",
        { amount: 500 },
        handler,
       );

       const row = await prisma.idempotencyKey.findUnique({
         where: { key: "key-timestamp" },
       });

       expect(row?.processingStartedAt).toBeInstanceOf(Date);
     });

  it("replays the stored response on a sequential retry with the same payload", async () => {
    let callCount = 0;
    const handler = async () => {
      callCount += 1;
      return { status: 201, body: { id: "charge-1" } };
    };

    const first = await withIdempotency(prisma, "key-retry", { amount: 100 }, handler);
    const second = await withIdempotency(prisma, "key-retry", { amount: 100 }, handler);

    expect(callCount).toBe(1);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.body).toEqual(first.body);
  });

  it("rejects reuse of the same key with a different payload", async () => {
    const handler = async () => ({ status: 201, body: { id: "charge-1" } });

    await withIdempotency(prisma, "key-reused", { amount: 100 }, handler);

    await expect(
      withIdempotency(prisma, "key-reused", { amount: 999 }, handler),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });
     it("treats nested objects with different property order as identical", async () => {
     let callCount = 0;

     const handler = async () => {
       callCount += 1;
       return { status: 201, body: { id: "charge-nested" } };
    };
      const first = await withIdempotency(
       prisma,
       "key-nested-order",
       {
         amount: 500,
         customer: { name: "Aakifah", id: "cus_1" },
       },
       handler,
     );

     const second = await withIdempotency(
       prisma,
       "key-nested-order",
       {
         customer: { id: "cus_1", name: "Aakifah" },
         amount: 500,
       },
       handler,
     );

     expect(callCount).toBe(1);
     expect(first.replayed).toBe(false);
     expect(second.replayed).toBe(true);
    expect(second.body).toEqual(first.body);
});
    it("rejects payloads containing undefined values", async () => {
     const handler = async () => ({
       status: 201,
       body: { id: "charge-undefined" },
     });

     await expect(
       withIdempotency(
         prisma,
         "key-undefined",
         { amount: 500, customerId: undefined },
         handler,
        ),
       ).rejects.toThrow("Payload cannot contain undefined values");

       const row = await prisma.idempotencyKey.findUnique({
         where: { key: "key-undefined" },
       });

       expect(row).toBeNull();
     });
        it("rejects NaN and Infinity values in payloads", async () => {
         const handler = async () => ({
           status: 201,
           body: { id: "charge-invalid-number" },
         });

         await expect(
           withIdempotency(
             prisma,
             "key-nan",
             { amount: NaN },
             handler,
            ),
           ).rejects.toThrow("Payload numbers must be finite");

           await expect(
             withIdempotency(
               prisma,
               "key-infinity",
               { amount: Infinity },
               handler,
              ),
             ).rejects.toThrow("Payload numbers must be finite");

             const nanRow = await prisma.idempotencyKey.findUnique({
               where: { key: "key-nan" },
             });

             const infinityRow = await prisma.idempotencyKey.findUnique({
               where: { key: "key-infinity" },
             });

             expect(nanRow).toBeNull();
             expect(infinityRow).toBeNull();
           });
              it("rejects Date objects in payloads", async () => {
               const handler = async () => ({
                 status: 201,
                 body: { id: "charge-date" },
               });

               await expect(
                 withIdempotency(
                   prisma,
                   "key-date",
                   {
                     amount: 500,
                     createdAt: new Date(),
                   },
                   handler,
                 ),
                ).rejects.toThrow(
                  "Payload must contain only plain JSON objects",
                );

                const row = await prisma.idempotencyKey.findUnique({
                  where: { key: "key-date" },
                });

                expect(row).toBeNull();
              });
                 it("rejects undefined values inside arrays", async () => {
                   const handler = async () => ({
                     status: 201,
                     body: { id: "charge-array" },
                   });

                   await expect(
                     withIdempotency(
                       prisma,
                       "key-array-undefined",
                       {
                         amount: 500,
                         items: [100, undefined, 200],
                        },
                        handler,
                       ),
                      ).rejects.toThrow("Payload contains an unsupported value");

                      const row = await prisma.idempotencyKey.findUnique({
                        where: { key: "key-array-undefined" },
                      });

                      expect(row).toBeNull();
                    });
                       it("rejects functions inside payloads", async () => {
                         const handler = async () => ({
                          status: 201,
                          body: { id: "charge-function" },
                        });

                         await expect(
                           withIdempotency(
                             prisma,
                             "key-function",
                             {
                               amount: 500,
                               callback: () => console.log("payment"),
                              },
                              handler,
                             ),
                            ).rejects.toThrow("Payload contains an unsupported value");

                            const row = await prisma.idempotencyKey.findUnique({
                              where: { key: "key-function" },
                            });

                            expect(row).toBeNull();
                          });
   it("treats payloads with different property order as identical", async () => {
      let callCount = 0;

      const handler = async () => {
        callCount += 1;
        return { status: 201, body: { id: "charge-1" } };
  };
      const first = await withIdempotency(
        prisma,
        "key-property-order",
        { amount: 500, currency: "USD" },
        handler,
  );

      const second = await withIdempotency(
        prisma,
        "key-property-order",
        { currency: "USD", amount: 500 },
        handler,
  );

      expect(callCount).toBe(1);
      expect(first.replayed).toBe(false);
      expect(second.replayed).toBe(true);
    expect(second.body).toEqual(first.body);
});
  it("does not poison the key on failure — a fresh key can still succeed", async () => {
    const failingHandler = async (): Promise<never> => {
      throw new Error("processor declined");
    };

    await expect(
      withIdempotency(prisma, "key-fails", { amount: 100 }, failingHandler),
    ).rejects.toThrow("processor declined");

    const row = await prisma.idempotencyKey.findUnique({ where: { key: "key-fails" } });
    expect(row?.status).toBe("failed");
    expect(row?.processingStartedAt).toBeInstanceOf(Date);

    // A different key for a different request is unaffected.
    const okHandler = async () => ({ status: 201, body: { id: "charge-ok" } });
    const result = await withIdempotency(prisma, "key-ok", { amount: 100 }, okHandler);
    expect(result.replayed).toBe(false);
  });
      it("keeps the key recoverable when the processor outcome is unknown", async () => {
  const key = "key-unknown-processor-outcome";
  const requestPayload = { amount: 500 };

  const handler = async (): Promise<never> => {
    throw new ProcessorOutcomeUnknownError(
      "Processor response was lost; payment outcome is unknown",
    );
  };

  await expect(
    withIdempotency(prisma, key, requestPayload, handler),
  ).rejects.toThrow("payment outcome is unknown");

  // The key must remain recoverable, not permanently failed.
  const rowAfterError = await prisma.idempotencyKey.findUnique({
    where: { key },
  });

  expect(rowAfterError?.status).toBe("processing");
  expect(rowAfterError?.processingToken).not.toBeNull();

  // Simulate the original processing attempt becoming stale.
  await prisma.idempotencyKey.update({
    where: { key },
    data: {
      processingStartedAt: new Date(Date.now() - 3 * 60 * 1000),
    },
  });

  let recoveryCallCount = 0;

  const recovered = await withIdempotency(
    prisma,
    key,
    requestPayload,
    async () => {
      throw new Error("The original handler must not run again");
    },
    async () => {
      recoveryCallCount += 1;

      return {
        status: 201,
        body: { id: "recovered-unknown-payment" },
      };
    },
  );

  expect(recoveryCallCount).toBe(1);
  expect(recovered.replayed).toBe(true);
  expect(recovered.body).toEqual({
    id: "recovered-unknown-payment",
  });

  const finalRow = await prisma.idempotencyKey.findUnique({
    where: { key },
  });

  expect(finalRow?.status).toBe("completed");
  expect(finalRow?.responseStatus).toBe(201);
  expect(finalRow?.responseBody).toEqual({
    id: "recovered-unknown-payment",
  });
});
     it("recovers a stale processing key and stores the recovered response", async () => {
    const key = "key-recovery-success";
    const requestPayload = { amount: 500 };

    // Create a processing record that is older than the timeout.
    await prisma.idempotencyKey.create({
      data: {
        key,
        requestHash: createHash("sha256")
          .update(JSON.stringify(requestPayload))
          .digest("hex"),
        status: "processing",
        processingStartedAt: new Date(Date.now() - 3 * 60 * 1000),
        createdAt: new Date(Date.now() - 3 * 60 * 1000),
      },
    });

    let recoveryCallCount = 0;

    const result = await withIdempotency(
      prisma,
      key,
      requestPayload,
      async () => {
        throw new Error("The original handler should not run");
      },
      async () => {
        recoveryCallCount += 1;

        return {
          status: 201,
          body: { id: "recovered-charge" },
        };
      },
    );

    expect(recoveryCallCount).toBe(1);
    expect(result.replayed).toBe(true);
    expect(result.body).toEqual({ id: "recovered-charge" });

    const row = await prisma.idempotencyKey.findUnique({
      where: { key },
    });
    expect(row?.status).toBe("completed");
    expect(row?.responseStatus).toBe(201);
    expect(row?.responseBody).toEqual({ id: "recovered-charge" });
  });
    it("keeps the key in recovering state when the recovery handler returns null", async () => {
  const key = "key-recovery-null";
  const requestPayload = { amount: 600 };

  await prisma.idempotencyKey.create({
    data: {
      key,
      requestHash: createHash("sha256")
        .update(JSON.stringify(requestPayload))
        .digest("hex"),
      status: "processing",
      processingStartedAt: new Date(Date.now() - 3 * 60 * 1000),
      createdAt: new Date(Date.now() - 3 * 60 * 1000),
    },
  });

  let recoveryCallCount = 0;
  let handlerCallCount = 0;

  await expect(
    withIdempotency(
      prisma,
      key,
      requestPayload,
      async () => {
        handlerCallCount += 1;
        throw new Error("The original handler should not run");
      },
      async () => {
        recoveryCallCount += 1;
        return null;
      },
    ),
  ).rejects.toThrow("manual reconciliation is required");

  expect(recoveryCallCount).toBe(1);
  expect(handlerCallCount).toBe(0);

  const row = await prisma.idempotencyKey.findUnique({
    where: { key },
  });

  expect(row?.status).toBe("recovering");
  expect(row?.responseStatus).toBeNull();
  expect(row?.responseBody).toBeNull();
  expect(row?.recoveryToken).not.toBeNull();
  expect(row?.recoveryStartedAt).not.toBeNull();
});
  
  it("allows only one request to claim recovery under real concurrency", async () => {
    const key = "key-recovery-concurrent";
    const requestPayload = { amount: 750 };

    // Create a processing record older than the recovery timeout.
    await prisma.idempotencyKey.create({
      data: {
        key,
        requestHash: createHash("sha256")
          .update(JSON.stringify(requestPayload))
          .digest("hex"),
        status: "processing",
        processingStartedAt: new Date(Date.now() - 3 * 60 * 1000),
        createdAt: new Date(Date.now() - 3 * 60 * 1000),
      },
    });

    let recoveryCallCount = 0;
    let handlerCallCount = 0;

    const recoveryHandler = async () => {
      recoveryCallCount += 1;

      // Simulate a little delay so concurrent requests overlap.
      await new Promise((resolve) => setTimeout(resolve, 200));

      return {
        status: 201,
        body: { id: "recovered-concurrent-charge" },
      };
    };

    const handler = async () => {
      handlerCallCount += 1;
      throw new Error("The original handler should not run");
    };

    const CONCURRENT_REQUESTS = 20;

    const results = await Promise.all(
      Array.from({ length: CONCURRENT_REQUESTS }, () =>
        withIdempotency(
          prisma,
          key,
          requestPayload,
          handler,
          recoveryHandler,
        ),
      ),
    );

    expect(recoveryCallCount).toBe(1);
    expect(handlerCallCount).toBe(0);

    expect(results).toHaveLength(CONCURRENT_REQUESTS);

    for (const result of results) {
      expect(result.replayed).toBe(true);
      expect(result.body).toEqual({
        id: "recovered-concurrent-charge",
      });
    }

    const row = await prisma.idempotencyKey.findUnique({
      where: { key },
    });

    expect(row?.status).toBe("completed");
    expect(row?.responseStatus).toBe(201);
    expect(row?.responseBody).toEqual({
      id: "recovered-concurrent-charge",
    });
    expect(row?.recoveryStartedAt).toBeNull();
expect(row?.recoveryToken).toBeNull();
  });
     it("keeps the key in recovering state when the recovery handler throws", async () => {
  const key = "key-recovery-failure";
  const requestPayload = { amount: 900 };

  await prisma.idempotencyKey.create({
    data: {
      
      key,
      requestHash: createHash("sha256")
        .update(JSON.stringify(requestPayload))
        .digest("hex"),
      status: "processing",
      processingStartedAt: new Date(Date.now() - 3 * 60 * 1000),
      createdAt: new Date(Date.now() - 3 * 60 * 1000),
    },
  });

  let recoveryCallCount = 0;
  let handlerCallCount = 0;

  await expect(
    withIdempotency(
      prisma,
      key,
      requestPayload,
      async () => {
        handlerCallCount += 1;
        throw new Error("The original handler should not run");
      },
      async () => {
        recoveryCallCount += 1;
        throw new Error("Recovery could not verify the payment");
      },
    ),
  ).rejects.toThrow("Recovery could not verify the payment");

  expect(recoveryCallCount).toBe(1);
  expect(handlerCallCount).toBe(0);

  const row = await prisma.idempotencyKey.findUnique({
    where: { key },
  });

  expect(row?.status).toBe("recovering");
  expect(row?.responseStatus).toBeNull();
  expect(row?.responseBody).toBeNull();
});
   it("allows another request to take over an expired recovery lease", async () => {
  const key = "key-expired-recovery-lease";
  const requestPayload = { amount: 950 };

  await prisma.idempotencyKey.create({
    data: {
      key,
      requestHash: createHash("sha256")
        .update(JSON.stringify(requestPayload))
        .digest("hex"),
      status: "recovering",
      processingStartedAt: new Date(Date.now() - 5 * 60 * 1000),
      recoveryStartedAt: new Date(Date.now() - 2 * 60 * 1000),
      recoveryToken: "old-recovery-token",
      createdAt: new Date(Date.now() - 5 * 60 * 1000),
    },
  });

  let recoveryCallCount = 0;
  let handlerCallCount = 0;

  const result = await withIdempotency(
    prisma,
    key,
    requestPayload,
    async () => {
      handlerCallCount += 1;
      throw new Error("The original handler should not run");
    },
    async () => {
      recoveryCallCount += 1;

      const rowDuringRecovery =
        await prisma.idempotencyKey.findUnique({
          where: { key },
        });

      expect(rowDuringRecovery?.status).toBe("recovering");
      expect(rowDuringRecovery?.recoveryToken).not.toBe(
        "old-recovery-token",
      );
      expect(rowDuringRecovery?.recoveryStartedAt).not.toBeNull();

      return {
        status: 201,
        body: { id: "recovered-after-expired-lease" },
      };
    },
  );

  expect(recoveryCallCount).toBe(1);
  expect(handlerCallCount).toBe(0);
  expect(result.replayed).toBe(true);
  expect(result.body).toEqual({
    id: "recovered-after-expired-lease",
  });

  const finalRow = await prisma.idempotencyKey.findUnique({
    where: { key },
  });

  expect(finalRow?.status).toBe("completed");
  expect(finalRow?.recoveryToken).toBeNull();
  expect(finalRow?.recoveryStartedAt).toBeNull();
});
it("prevents an older recovery attempt from overwriting a newer recovery result", async () => {
  const key = "key-overlapping-recovery";
  const requestPayload = { amount: 1000 };

  await prisma.idempotencyKey.create({
    data: {
      key,
      requestHash: createHash("sha256")
        .update(JSON.stringify(requestPayload))
        .digest("hex"),
      status: "processing",
      processingStartedAt: new Date(Date.now() - 3 * 60 * 1000),
      createdAt: new Date(Date.now() - 3 * 60 * 1000),
    },
  });

  let releaseFirstRecovery!: () => void;

  const firstRecoveryPaused = new Promise<void>((resolve) => {
    releaseFirstRecovery = resolve;
  });

  let firstRecoveryStarted!: () => void;

  const firstRecoveryStartedPromise = new Promise<void>((resolve) => {
    firstRecoveryStarted = resolve;
  });

  const handler = async () => {
    throw new Error("The original handler should not run");
  };

  const firstRequest = withIdempotency(
    prisma,
    key,
    requestPayload,
    handler,
    async () => {
      firstRecoveryStarted();

      await firstRecoveryPaused;

      return {
        status: 201,
        body: { id: "older-recovery-result" },
      };
    },
  );

  await firstRecoveryStartedPromise;

  await prisma.idempotencyKey.update({
    where: { key },
    data: {
      recoveryStartedAt: new Date(Date.now() - 2 * 60 * 1000),
    },
  });

  const secondResult = await withIdempotency(
    prisma,
    key,
    requestPayload,
    handler,
    async () => ({
      status: 201,
      body: { id: "newer-recovery-result" },
    }),
  );

  expect(secondResult.body).toEqual({
    id: "newer-recovery-result",
  });

  releaseFirstRecovery();

  await expect(firstRequest).rejects.toThrow(
    "could not be marked as completed",
  );

  const finalRow = await prisma.idempotencyKey.findUnique({
    where: { key },
  });

  expect(finalRow?.status).toBe("completed");
  expect(finalRow?.responseStatus).toBe(201);
  expect(finalRow?.responseBody).toEqual({
    id: "newer-recovery-result",
  });
  expect(finalRow?.recoveryToken).toBeNull();
  expect(finalRow?.recoveryStartedAt).toBeNull();
});
it("prevents an older processing request from overwriting a recovery result", async () => {
    const key = "key-processing-ownership";
    const requestPayload = { amount: 900 };

    let releaseOriginalHandler!: () => void;
    let signalOriginalHandlerStarted!: () => void;

    const originalHandlerStarted = new Promise<void>((resolve) => {
      signalOriginalHandlerStarted = resolve;
    });

    const originalHandlerPaused = new Promise<void>((resolve) => {
      releaseOriginalHandler = resolve;
    });

    const originalHandler = async () => {
      signalOriginalHandlerStarted();

      await originalHandlerPaused;

      return {
        status: 201,
        body: { id: "older-processing-result" },
      };
    };

    const firstRequest = withIdempotency(
      prisma,
      key,
      requestPayload,
      originalHandler,
    );

    await originalHandlerStarted;

    // Simulate the original processing request becoming stale.
    await prisma.idempotencyKey.update({
      where: { key },
      data: {
        processingStartedAt: new Date(Date.now() - 3 * 60 * 1000),
      },
    });

    // A second request takes over through recovery.
    const secondResult = await withIdempotency(
      prisma,
      key,
      requestPayload,
      async () => {
        throw new Error("The second handler should not run");
      },
      async () => ({
        status: 201,
        body: { id: "newer-recovery-result" },
      }),
    );

    expect(secondResult.body).toEqual({
      id: "newer-recovery-result",
    });

    // Allow the original processing request to finish.
    releaseOriginalHandler();

    await expect(firstRequest).rejects.toThrow(
      "Processing ownership lost",
    );

    const finalRow = await prisma.idempotencyKey.findUnique({
      where: { key },
    });

    expect(finalRow?.status).toBe("completed");
    expect(finalRow?.responseStatus).toBe(201);
    expect(finalRow?.responseBody).toEqual({
      id: "newer-recovery-result",
    });
    expect(finalRow?.processingToken).toBeNull();
  });
  
});
