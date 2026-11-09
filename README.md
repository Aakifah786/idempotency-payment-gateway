Idempotent Payment Gateway

A retry-safe payment gateway API built with Node.js, TypeScript, Express, PostgreSQL and Prisma.

The project demonstrates how payment systems can prevent duplicate charges when clients retry requests, experience network failures, or send concurrent requests using the same idempotency key.

A client can submit the same payment request multiple times, including simultaneously, without creating duplicate processor transactions.

Key Features

- Idempotent payment requests: Repeated requests with the same key and payload replay the original response.
- Payload conflict detection: Reusing an idempotency key with different payment details returns HTTP 422.
- Concurrency protection: Database unique constraints prevent duplicate idempotency records across concurrent requests.
- Processing ownership: Processing tokens prevent outdated handlers from overwriting newer results.
- Failure recovery: Recovery leases and stale-request detection support recovery after interrupted processing.
- Processor transaction persistence: Processor transactions are stored independently of gateway charge records.
- Uncertain outcome handling: The API provides safe retry instructions when a processor outcome cannot be confirmed.
- Database integrity: Foreign-key relationships, unique constraints and positive-amount database checks protect stored data.
- Health monitoring: Separate endpoints check server liveness and database readiness.
- Automated testing: Integration-focused tests use PostgreSQL to verify payment, concurrency and recovery behaviour.

Technology Stack

Component| Technology
Runtime| Node.js 20+
Language| TypeScript
Backend| Express.js
Database| PostgreSQL 16
ORM| Prisma
Testing| Vitest
HTTP testing| Supertest
Database environment| Docker Compose

Architecture Overview

The application separates request handling, idempotency management, processor simulation and database persistence.

Main components

- Express API ("server.ts"): Validates requests, handles HTTP responses and coordinates payment processing.
- Idempotency service ("idempotency.ts"): Manages request ownership, duplicate detection, response replay and recovery.
- Fake processor ("processor.ts"): Simulates processor transactions, latency, database failures and uncertain outcomes.
- Prisma client ("prismaClient.ts"): Provides database access.
- Error definitions ("errors.ts"): Defines application-specific errors.

Database models

The database contains three primary models:

1. IdempotencyKey: Stores the request hash, processing status, response information and processing/recovery ownership tokens.
2. Charge: Stores the payment record maintained by the gateway.
3. ProcessorTransaction: Stores the processor-side transaction independently of the gateway charge record.

Unique constraints protect idempotency keys and transaction identifiers. Database-level positive-amount constraints prevent invalid payment amounts from being stored.

How Idempotency Works

Every payment request must include an "Idempotency-Key" header.

The gateway follows this general process:

1. Validates the request and normalizes its payment details.
2. Generates a SHA-256 hash of the normalized request payload.
3. Attempts to claim the idempotency key in PostgreSQL.
4. Uses database uniqueness to coordinate concurrent requests.
5. Processes the payment only when the request successfully obtains processing ownership.
6. Persists the response and marks the idempotency record as completed.
7. Replays the stored response for subsequent requests using the same key and payload.

If the same key is submitted with a different payload, the request is rejected with HTTP 422.

An in-memory map also coordinates in-flight processor calls within an application instance. PostgreSQL remains the authoritative source of durable idempotency and concurrency protection.

Failure Recovery

A payment system must handle more than successful requests. A processor may complete a payment while the application loses the response or fails to persist its own charge record.

This implementation includes recovery mechanisms for these scenarios.

Processing ownership

Processing tokens identify the current owner of a payment operation. An outdated handler cannot overwrite a result committed by a newer owner.

Recovery leases

Recovery tokens and timestamps allow one request to claim recovery ownership. Expired recovery leases can be taken over by another request.

Uncertain processor outcomes

If a processor transaction may have succeeded but its outcome cannot be confirmed, the idempotency record remains recoverable.

A subsequent request using the same key can query the processor transaction and restore the missing gateway charge record.

Persistence failures

Processor transactions and gateway charge records are stored separately. This allows the application to recover when the processor transaction exists but the gateway charge record has not been saved.

The implementation uses simulated processor behaviour; it does not connect to a real payment provider.

API Reference

1. Create a charge

"POST /charges"

Required header:

"Idempotency-Key: unique-payment-key"

Request body:

{
  "amount": 500,
  "currency": "INR",
  "customerId": "cus_123"
}

- "amount": Positive integer representing the smallest currency unit.
- "currency": Supported currencies are INR, USD and EUR.
- "customerId": Non-empty customer identifier.

Successful response: HTTP 201

The response includes the saved charge record.

Response header:

- "Idempotent-Replayed: false" for the original processing result.
- "Idempotent-Replayed: true" when an existing result is replayed.

2. Check server health

"GET /health"

Returns HTTP 200 when the Express application is running.

{
  "ok": true
}

3. Check database readiness

"GET /ready"

Executes a database connectivity check.

When PostgreSQL is reachable:

{
  "ready": true
}

When the database check fails, the endpoint returns HTTP 503.

Error responses

HTTP status| Meaning
400| Invalid request or missing Idempotency-Key
422| Idempotency key reused with a different payload
503| Payment outcome uncertain or gateway persistence failure
500| Unexpected internal processing error

For uncertain outcomes and persistence failures, clients are instructed to retry using the same Idempotency-Key, not a new key.

Getting Started

Prerequisites

- Node.js 20 or later
- npm
- Docker Desktop with Docker Compose, or a local PostgreSQL installation

1. Clone the repository

git clone <your-github-repository-url>
cd 02-idempotent-payment-gateway

2. Install dependencies

npm install

3. Start PostgreSQL

Using Docker Compose:

docker compose up -d

4. Configure environment variables

Create a ".env" file using ".env.example" as a reference.

Example:

DATABASE_URL="postgresql://gateway:gateway@localhost:5432/payment_gateway"
PORT=3000

Adjust the database connection string if you use a different PostgreSQL configuration.

5. Apply database migrations

npx prisma migrate deploy

6. Generate the Prisma client

npm run prisma:generate

7. Start the application

npm run dev

The API will be available at:

"http://localhost:3000"

Running Tests

Run the complete test suite:

npm test

Build the TypeScript project:

npm run build

The test suite covers:

- Idempotency and response replay.
- Concurrent duplicate requests.
- Request validation and payload conflicts.
- Processor transaction persistence.
- Processing and recovery ownership.
- Stale-request recovery.
- Uncertain processor outcomes.
- Gateway persistence failures.
- HTTP error handling.
- Server health and database readiness.
- Oversized JSON request rejection.

Latest verified project results:

- 50 automated tests passed.
- TypeScript build completed with zero errors.

The tests use PostgreSQL for database integration and concurrency verification, with controlled fault injection for specific failure scenarios.

Project Structure

02-idempotent-payment-gateway/
│
├── src/
│   ├── server.ts
│   ├── idempotency.ts
│   ├── processor.ts
│   ├── prismaClient.ts
│   └── errors.ts
│
├── prisma/
│   ├── schema.prisma
│   └── migrations/
│
├── tests/
│   ├── idempotency.test.ts
│   ├── charges.route.test.ts
│   └── processor.test.ts
│
├── docker-compose.yml
├── .env.example
├── package.json
├── tsconfig.json
└── README.md

Design Decisions

Why PostgreSQL instead of Redis for correctness?

PostgreSQL unique constraints provide durable coordination and prevent duplicate idempotency-key claims.

Redis could be introduced as a caching layer to improve replay performance, but it is not required for the correctness guarantees implemented here.

Why are processor transactions stored separately?

The processor transaction must remain independently recoverable even when the gateway fails to persist its own charge record.

This separation allows the gateway to reconcile an uncertain payment outcome without processing the payment again.

Why are external processor calls performed outside long database transactions?

Holding database transactions open during external processor calls can consume database connections and increase contention.

The implementation claims processing ownership first and performs the slower processing operation separately.

Current Scope and Limitations

This is an educational backend engineering project that simulates important payment gateway reliability patterns. It is not a production payment service.

- No real payment provider: "FakeProcessor" simulates transaction processing. It does not integrate with Stripe, Razorpay or another payment provider.
- No Redis: PostgreSQL handles durable idempotency and coordination. Redis caching is outside the current scope.
- No webhooks: Retry-safe webhook delivery and merchant notification handling are possible future extensions.
- No authentication: API authentication, authorization and merchant management are not implemented.
- No production deployment: Production infrastructure, provider-side reconciliation, observability and operational controls would require additional implementation.

Future Enhancements

Potential extensions include:

- Integration with a real payment provider and provider-side idempotency.
- Idempotent webhook delivery.
- Structured logging and metrics.
- Authentication and merchant-level authorization.
- Deployment with production-grade infrastructure.
- Automated reconciliation and operational monitoring.

What This Project Demonstrates

- Backend API development using TypeScript and Express.
- Relational database design using PostgreSQL and Prisma.
- Database-level concurrency control.
- Idempotent request processing.
- Failure handling and recovery strategies.
- Transaction persistence and data consistency.
- Automated integration testing with Vitest and Supertest.

Attribution

This project was developed using the original Idempotent Payment Gateway project as a starting reference.

Original reference: "College-Capstone-Projects by techwithprateek" (https://github.com/techwithprateek/College-Capstone-Projects/tree/main/projects/02-idempotent-payment-gateway)

The implementation has been extended with additional reliability mechanisms, database consistency improvements, failure recovery, API error handling, and automated tests as part of my learning and development work.