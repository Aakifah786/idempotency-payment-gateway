export class IdempotencyConflictError extends Error {
  constructor(key: string) {
    super(`Idempotency-Key "${key}" was already used with a different request payload`);
    this.name = "IdempotencyConflictError";
  }
}
 export class PaymentPersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentPersistenceError";
  }
}
 export class ProcessorOutcomeUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProcessorOutcomeUnknownError";
  }
}