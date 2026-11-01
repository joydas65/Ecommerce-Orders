# Ecommerce Orders

A Node.js 24 order service for the [Joys Store Next.js storefront](https://github.com/joydas65/Ecommerce-Store). The storefront and this separate backend run on Vercel; PostgreSQL on Neon Free stores quotes, orders, payment attempts and webhook deduplication records.

Two checkout paths share authoritative prices and durable receipts: a credential-free simulation and optional Stripe hosted **test** checkout. Stripe support accepts only test keys and test events; it cannot collect real money. Session creation and a successful browser redirect never count as payment confirmation. The service does not store names, email addresses, street addresses or card details; use synthetic information on Stripe's hosted test page.

Read the [API contract](contract/openapi.yaml), [deployment runbook](docs/deployment.md) and [free hosting limits](docs/costs.md).

Set `NODEJS_HELPERS=0` in every backend Vercel environment **before building**. This preserves the raw request stream for bounded JSON parsing and Stripe signature verification. Do not parse or reserialize webhook bodies before verification.

## Local development

Requirements: Node.js 24 and Docker. Use a disposable local database for tests; the test runner rejects remote database URLs.

```sh
docker run --detach --name orders-postgres --publish 127.0.0.1:5433:5432 -e POSTGRES_DB=orders_test -e POSTGRES_USER=orders_test -e POSTGRES_PASSWORD=local-only postgres:17-alpine@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b
npm ci --ignore-scripts
```

Copy `.env.example` to an ignored environment file, generate independent secrets, then load it into your development shell. Environment files are not loaded automatically.

```sh
npm run check
npm test
node --test scripts/release/*.test.mjs
npm run migrate
npm start
```

The API listens at `http://127.0.0.1:4100`. The Docker container preserves data across application restarts; removing it discards that database unless you add a volume. Tests reset isolated database state, so do not point them at a database containing receipts you need to retain.

Configure the storefront with `NEXT_PUBLIC_CATALOG_PROVIDER=seeded`, `NEXT_PUBLIC_PAYMENT_PROVIDER=simulated`, `NEXT_PUBLIC_ORDER_STORAGE=remote`, `ORDERS_API_URL=http://127.0.0.1:4100`, `ORDERS_ALLOW_LOCAL_API=true` and the same server-only `ORDERS_API_SECRET`. Local HTTP is never allowed on Vercel. Never expose the shared secret through a `NEXT_PUBLIC_` variable.

For optional Stripe testing, follow the runbook's sandbox setup and set the storefront payment provider to `stripe`. Simulation works with all Stripe variables omitted. The application has no live-payment configuration.

## Behavior and architecture

- Quotes use a versioned server price book, integer cents, shipping and illustrative 8% sample tax. Client price fields are rejected. A quote records its payment provider and cannot cross between simulated and Stripe checkout.
- A PostgreSQL transaction locks the quote and writes the order plus idempotency record together. The same key and request return the original attempt; conflicting reuse fails. Stripe creation uses a separate stable provider key derived from the durable order, so a lost response can be retried without a second payment session.
- Stripe orders begin `PENDING_PAYMENT`. Verified signed webhooks and guest-authorized reconciliation retrieve fresh Stripe state, validate the order identity, test mode, currency, exact total and item breakdown, then persist `CONFIRMED/PAID`, `CANCELED/CANCELED` or `PAYMENT_REVIEW/REQUIRES_REVIEW`. Cancellation expires the provider session and rechecks its actual state, including a payment racing with cancellation. Paid state cannot be downgraded by an older event.
- A return URL proves navigation only. Mismatched provider data and unresolved creation beyond the 23-hour retry window require review instead of another session. There is no background reconciliation worker or operator review console yet.
- The server-to-server bearer secret authenticates the storefront. An opaque, HttpOnly guest cookie identifies the browser session; receipt reads also require that guest's ownership. Knowing an order ID alone is insufficient. Signed webhooks use a distinct authentication path.
- Quotes last 15 minutes. Resolved receipts normally expire after 30 days; payment confirmation starts a fresh 30-day period. Unresolved Stripe pending/review records stay readable and are excluded from cleanup until resolved, preserving recovery evidence. Clearing the guest cookie loses that guest's access; customer accounts and cross-device receipts are outside this step.
- Remote database connections verify TLS certificates and use a small pool. Durable state lives in PostgreSQL, never function memory or filesystem.

Backend tests exercise real PostgreSQL transactions, concurrent requests, retries, ownership, payment-state transitions and signed raw-body events using an injected provider fixture. They do not contact Stripe. Storefront CI separately runs real-database simulated purchases and deterministic Stripe browser contract fixtures. The optional deployed Stripe gate creates and cancels an unpaid test session without card entry. A real hosted sandbox payment is a separate integration verification; no Stripe keys belong in GitHub CI.

Main-only migrations run after verification and are required Vercel Deployment Checks before production promotion. See the runbook for the account settings that activate this gate.

## Deliberate tradeoffs

Two repositories expose a clear API and deployment boundary, with extra coordination when the contract changes. Node keeps setup small; PostgreSQL transactions and constraints make concurrency explicit. Stripe's external side effect cannot participate in the database transaction, so durable attempt identity, provider idempotency, fresh retrieval and review states handle uncertainty.

Free plans can pause at quotas and wake from idle. This is a personal portfolio demonstration, without commercial uptime promises. Shared service authentication requires coordinated rotation. Real commerce would still need inventory reservation, authenticated customers, real tax and shipping rules, fulfillment, refunds, monitoring and audited operations. Enabling live payments requires a separate design and hosting review; replacing a test key is deliberately rejected.
