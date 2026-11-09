import express, { type Request, type Response } from "express";
import { prisma } from "./prismaClient.js";
import { FakeProcessor } from "./processor.js";
import { withIdempotency } from "./idempotency.js";
import {
  IdempotencyConflictError,
  PaymentPersistenceError,
  ProcessorOutcomeUnknownError,
} from "./errors.js";
import { pathToFileURL} from "node:url";


export function createApp(processor: FakeProcessor = new FakeProcessor()) {
  const app = express();
  app.use(express.json({ limit:"10kb" }));

  app.post("/charges", async (req: Request, res: Response) => {
    const rawIdempotencyKey = req.header("Idempotency-Key");
const idempotencyKey = rawIdempotencyKey?.trim();
    if (!idempotencyKey || idempotencyKey.trim() === "") {
    return res.status(400).json({ error: "Idempotency-Key header is required" });
}

    const { amount, currency: rawCurrency, customerId } = req.body ?? {};
    const currency = typeof rawCurrency === "string" ? rawCurrency.trim().toUpperCase() : rawCurrency;
    const supportedCurrencies = ["INR", "USD", "EUR"];
    if (
      typeof amount !== "number" ||
      !Number.isInteger(amount) ||
      amount <= 0 ||
      typeof currency !== "string" ||
      !supportedCurrencies.includes(currency) ||
      typeof customerId !== "string" ||
      customerId.trim() === ""
    ) {
      return res.status(400).json({
        error: "amount (positive number), currency, and customerId are required",
      });
    }
     const normalizedPayload = {
       amount,
       currency,
       customerId: customerId.trim(),
      };
    try {
      
      const result = await withIdempotency(
        prisma,
        idempotencyKey,
        normalizedPayload,
        async () => {
          const charge = await processor.charge({
  amount,
  currency,
  customerId: customerId.trim(),
  idempotencyKey,
});

let savedCharge;

try {
  savedCharge = await prisma.charge.create({
    data: {
      idempotencyKey,
      processorChargeId: charge.id,
      amount: charge.amount,
      currency: charge.currency,
      customerId: charge.customerId,
      status: charge.status,
    },
  });
} catch {
  throw new PaymentPersistenceError(
    "Payment succeeded, but saving the charge to the database failed",
  );
}

return { status: 201, body: savedCharge };
},
  async () => {
    const existingCharge =
  await processor.findChargeByIdempotencyKey(idempotencyKey);

    if (!existingCharge) return null;

    const savedExistingCharge = await prisma.charge.upsert({
  where: { idempotencyKey },
  create: {
    idempotencyKey,
    processorChargeId: existingCharge.id,
    amount: existingCharge.amount,
    currency: existingCharge.currency,
    customerId: existingCharge.customerId,
    status: existingCharge.status,
  },
  update: {},
});

if (
  savedExistingCharge.processorChargeId !== existingCharge.id ||
  savedExistingCharge.amount !== existingCharge.amount ||
  savedExistingCharge.currency !== existingCharge.currency ||
  savedExistingCharge.customerId !== existingCharge.customerId ||
  savedExistingCharge.status !== existingCharge.status
) {
  throw new Error(
    "Existing charge record does not match the recovered processor charge",
  );
}

return { status: 201, body: savedExistingCharge };
  },
);

      res.status(result.status).set("Idempotent-Replayed", String(result.replayed)).json(result.body);
    } catch (err) {
  if (err instanceof IdempotencyConflictError) {
    return res.status(422).json({ error: err.message });
  }
  if (err instanceof PaymentPersistenceError) {
  console.error(err);

  return res.status(503).json({
    error: "Payment succeeded, but the gateway could not save the charge",
    code: "PAYMENT_PERSISTENCE_FAILED",
    message:
      "Retry using the same Idempotency-Key. Do not submit a new payment with a different key.",
  });
}

  if (err instanceof ProcessorOutcomeUnknownError) {
    console.error(err);

    return res.status(503).json({
      error: "Payment outcome could not be confirmed",
      code: "PROCESSOR_OUTCOME_UNKNOWN",
      message:
        "Do not submit a new payment with a different idempotency key. Retry using the same key.",
    });
  }

  console.error(err);

  res.status(500).json({
    error: "Internal error processing charge",
  });
}
  });

  app.get("/health", (_req: Request, res: Response) => res.json({ ok: true }));
  app.get("/ready", async (_req: Request, res: Response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return res.json({ ready: true });
  } catch {
    return res.status(503).json({ ready: false });
  }
});

  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 3000);
  createApp().listen(port, () => {
    console.log(`Payment gateway listening on http://localhost:${port}`);
  });
}
