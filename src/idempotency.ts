
import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  IdempotencyConflictError,
  PaymentPersistenceError,
  ProcessorOutcomeUnknownError,
} from "./errors.js";

const MAX_WAIT_TIME_MS = 30 * 1000;
const RETRY_DELAY_MS = 100;
const PROCESSING_TIMEOUT_MS = 2 * 60 * 1000;
const RECOVERY_LEASE_MS = 60 * 1000;

function canonicalize(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Payload numbers must be finite");
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }

  if (typeof value === "object" && value !== null) {
    const prototype = Object.getPrototypeOf(value);

    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Payload must contain only plain JSON objects");
    }

    const sorted: Record<string, unknown> = {};

    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];

      if (item === undefined) {
        throw new TypeError("Payload cannot contain undefined values");
      }

      sorted[key] = canonicalize(item);
    }

    return sorted;
  }

  throw new TypeError("Payload contains an unsupported value");
}

function hashPayload(payload: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(payload)))
    .digest("hex");
}

function isUniqueConstraintViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === "P2002"
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface HandlerResult<T> {
  status: number;
  body: T;
}
export type RecoveryHandler<T> = () => Promise<HandlerResult<T> | null>;

export interface IdempotentResult<T> extends HandlerResult<T> {
  replayed: boolean;
}

export async function withIdempotency<T>(
  prisma: PrismaClient,
  key: string,
  requestPayload: unknown,
  handler: () => Promise<HandlerResult<T>>,
  recover?: RecoveryHandler<T>,
): Promise<IdempotentResult<T>> {
  const requestHash = hashPayload(requestPayload);

  const startTime = Date.now();

  while (Date.now() - startTime < MAX_WAIT_TIME_MS) {
    const existing = await prisma.idempotencyKey.findUnique({
      where: { key },
    });

    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new IdempotencyConflictError(key);
      }

      if (existing.status === "completed") {
        return {
          status: existing.responseStatus!,
          body: existing.responseBody as T,
          replayed: true,
        };
      }

      if (existing.status === "failed") {
        throw new Error(
          `Idempotency key "${key}" previously failed; not retrying automatically`,
        );
      }

      // Check whether another request has been processing too long.
      const processingAge =
        Date.now() -
        (existing.processingStartedAt?.getTime() ??
          existing.createdAt.getTime());

      if (processingAge > PROCESSING_TIMEOUT_MS) {
        if (!recover) {
          throw new Error(
            `Idempotency key "${key}" is stuck in processing; manual reconciliation is required`,
          );
        }
        const recoveryToken = randomUUID();

        // Atomically claim recovery so only one request can perform it.
        const recoveryClaim = await prisma.idempotencyKey.updateMany({
          where: {
  key,
  OR: [
    {
      status: "processing",
      OR: [
        {
          processingStartedAt: {
            lte: new Date(Date.now() - PROCESSING_TIMEOUT_MS),
          },
        },
        {
          processingStartedAt: null,
          createdAt: {
            lte: new Date(Date.now() - PROCESSING_TIMEOUT_MS),
          },
        },
      ],
    },
    {
      status: "recovering",
      OR: [
        {
          recoveryStartedAt: {
            lte: new Date(Date.now() - RECOVERY_LEASE_MS),
          },
        },
        {
          recoveryStartedAt: null,
        },
      ],
    },
  ],
},
data: {
  status: "recovering",
  processingToken: null,
  recoveryStartedAt: new Date(),
  recoveryToken,
},
});
        if (recoveryClaim.count === 1) {
          const recovered = await recover();

          if (!recovered) {
            throw new Error(
              `Idempotency key "${key}" is stuck in processing; manual reconciliation is required`,
            );
          }

          const completionUpdate =
            await prisma.idempotencyKey.updateMany({
              where: {
                key,
                status: "recovering",
                recoveryToken,
              },
              data: {
                status: "completed",
                responseStatus: recovered.status,
                responseBody: recovered.body as Prisma.InputJsonValue,
                processingToken: null,
                recoveryStartedAt: null,
                recoveryToken: null,
              },
            });

          if (completionUpdate.count !== 1) {
            throw new Error(
              `Recovery completed, but idempotency key "${key}" could not be marked as completed`,
            );
          }

          return {
            ...recovered,
            replayed: true,
          };
        }
      
        // Another request has already claimed recovery.
        await sleep(RETRY_DELAY_MS);
        continue;
      }
    
      // Another request owns this key. Wait for it to finish.
      await sleep(RETRY_DELAY_MS);
      continue;
    }

    // No existing record: attempt to claim the key.
    // No existing record: attempt to claim the key.
    const processingToken = randomUUID();

    try {
      await prisma.idempotencyKey.create({
        data: {
          key,
          requestHash,
          status: "processing",
          processingStartedAt: new Date(),
          processingToken,
        },
      });
    } catch (err) {
      if (isUniqueConstraintViolation(err)) {
        // Another request claimed this key first.
        continue;
      }

      throw err;
    }

    // We successfully claimed the key.
    let result: HandlerResult<T>;

    try {
      result = await handler();
    } catch (err) {
      if (
        err instanceof PaymentPersistenceError ||
        err instanceof ProcessorOutcomeUnknownError
      ) {
        throw err;
      }

      await prisma.idempotencyKey.updateMany({
  where: {
    key,
    status: "processing",
    processingToken,
  },
  data: {
    status: "failed",
    processingToken: null,
  },
});

      throw err;
    }

    // Keep completion recording separate from handler execution.
    const completionUpdate = await prisma.idempotencyKey.updateMany({
  where: {
    key,
    status: "processing",
    processingToken,
  },
  data: {
    status: "completed",
    responseStatus: result.status,
    responseBody: result.body as Prisma.InputJsonValue,
    processingToken: null,
  },
});

if (completionUpdate.count !== 1) {
  throw new Error(
    `Processing ownership lost for idempotency key "${key}"`,
  );
}

    return { ...result, replayed: false };
  }

  throw new Error(
    `Idempotency key "${key}" did not resolve within ${MAX_WAIT_TIME_MS / 1000} seconds`,
  );
}
