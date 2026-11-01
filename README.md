# Ecommerce Orders

A Node.js 24 order service for the [Joys Store Next.js storefront](https://github.com/joydas65/Ecommerce-Store). The storefront runs on Vercel; this separate backend runs as a Vercel Node function and stores simulated orders in PostgreSQL on Neon Free.

The backend calculates quotes, commits orders transactionally and returns receipts that survive reloads and process restarts. It never charges money and does not store names, email addresses, street addresses or card details. All order confirmations explicitly identify the purchase as simulated.

Read the [API contract](contract/openapi.yaml), [deployment runbook](docs/deployment.md) and [free hosting limits](docs/costs.md).

Set `NODEJS_HELPERS=0` in every backend Vercel environment **before building**. This keeps request bodies as raw streams so the service's JSON parsing and size limit remain authoritative. The Vercel build and built Node adapter were checked locally, including malformed and oversized request rejection.

## Local development

Requirements: Node.js 24 and Docker. Use a disposable local database for tests; the test runner rejects remote database URLs.

```sh
docker run --detach --name orders-postgres --publish 127.0.0.1:5433:5432 -e POSTGRES_DB=orders_test -e POSTGRES_USER=orders_test -e POSTGRES_PASSWORD=local-only postgres:17-alpine@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b
npm ci
```

Set these in a local, ignored environment file and load it into your development shell:

```dotenv
DATABASE_URL=postgres://orders_test:local-only@127.0.0.1:5433/orders_test
ORDERS_API_SECRET=<random value generated from at least 32 bytes>
CRON_SECRET=<different random value generated from at least 32 bytes>
```

```sh
npm run check
npm test
node --test scripts/release/*.test.mjs
npm run migrate
npm start
```

The API listens at `http://127.0.0.1:4100`. The Docker container preserves its data across application restarts; removing the container discards that local database unless you add a volume. Tests use isolated database state and are not a substitute for a local demo database backup.

Configure the storefront locally with `NEXT_PUBLIC_COMMERCE_MODE=demo`, `NEXT_PUBLIC_DEMO_ORDER_STORAGE=remote`, `ORDERS_API_URL=http://127.0.0.1:4100`, `ORDERS_ALLOW_LOCAL_API=true` and the same server-only `ORDERS_API_SECRET`. Local HTTP is never allowed on Vercel. Never expose the shared secret through a `NEXT_PUBLIC_` variable.

## Behavior and architecture

- Quotes use a versioned server price book, integer cents, shipping and deterministic demo tax. Client price fields are rejected.
- A PostgreSQL transaction locks the quote and writes the receipt plus its idempotency record together. The same key and request return the original order; conflicting reuse fails. A lost response can be retried without a duplicate purchase.
- The server-to-server bearer secret authenticates the storefront. A separate guest cookie identifies the browser session; receipt reads also require that guest's ownership. Knowing an order ID alone is insufficient.
- Quotes last 15 minutes, receipts 30 days. Reads enforce expiry immediately; a daily authenticated cleanup removes expired rows. Clearing the guest cookie loses that guest's receipt access. Cross-device customer accounts are outside this demo.
- Remote database connections verify TLS certificates and use a small connection pool. The database supplies durable state; function memory and filesystem do not.

Tests exercise real PostgreSQL transactions, concurrency, retries, ownership, expiry and HTTP failures. CI checks each pull request without cloud credentials. Main-only migrations run after verification and are required Vercel Deployment Checks before a production alias can move. See the runbook for the account settings that activate this gate.

## Deliberate tradeoffs

Two repositories keep the API contract and deployment boundary clear, with extra coordination whenever that contract changes. Node keeps the operational setup small. PostgreSQL constraints and transactions make retry and concurrency behavior explicit without another queue or cache.

Free plans can pause at quotas and wake from idle; this is a portfolio demonstration with production-style boundaries, not a promise of commercial uptime. Shared service authentication is simpler than a full identity provider but requires coordinated secret rotation. Real commerce would add verified payment events, reconciliation, inventory reservation, authenticated customers, audited operations and a privacy policy.
