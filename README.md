# Ecommerce Orders

A Node.js 24 order service for the [Joys Store Next.js storefront](https://github.com/joydas65/Ecommerce-Store). The storefront and this separate backend run on Vercel; PostgreSQL on Neon Free stores quotes, orders, payment attempts and webhook deduplication records.

Two checkout paths share authoritative prices and durable receipts: a credential-free simulation and optional Stripe hosted **test** checkout. Stripe support accepts only test keys and test events; it cannot collect real money. Session creation and a successful browser redirect never count as payment confirmation. Order receipts do not store names, email addresses, street addresses or card details; optional shopper ownership is stored separately as an internal customer foreign key. Authentication profiles store the Google/GitHub identity needed for sign-in; use synthetic information on Stripe's hosted test page.

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
- A return URL proves navigation only. Mismatched provider data and unresolved creation beyond the 23-hour retry window require review instead of another session. There is no background reconciliation worker yet. The merchant inbox exposes pending/review records and an audited, retrieval-only payment recheck.
- The server-to-server bearer secret authenticates the storefront. An opaque, HttpOnly guest cookie identifies the browser session; receipt reads also require that guest's ownership. Knowing an order ID alone is insufficient. Signed webhooks use a distinct authentication path.
- Quotes last 15 minutes. Resolved receipts normally expire after 30 days; first verified payment or cancellation starts a fresh 30-day period. Unresolved Stripe pending/review records stay readable and are excluded from cleanup until resolved, preserving recovery evidence. Clearing the guest cookie loses that guest's access. Orders first submitted while signed in also have immutable customer ownership and remain readable from that account on another browser, subject to the same retention policy.
- Remote database connections verify TLS certificates and use a small pool. Durable state lives in PostgreSQL, never function memory or filesystem.

Backend tests exercise real PostgreSQL transactions, concurrent requests, retries, ownership, payment-state transitions and signed raw-body events using an injected provider fixture. They do not contact Stripe. Storefront CI separately runs real-database simulated purchases and deterministic Stripe browser contract fixtures. The optional deployed Stripe gate creates and cancels an unpaid test session without card entry. A real hosted sandbox payment is a separate integration verification; no Stripe keys belong in GitHub CI.

Main-only migrations run after verification and are required Vercel Deployment Checks before production promotion. See the runbook for the account settings that activate this gate.

## Private merchant order inbox

The optional inbox uses GitHub sign-in through Better Auth and the same PostgreSQL database, with an optional explicitly linked Google sign-in method. Access is granted only to explicitly allowlisted **immutable numeric GitHub account IDs**. An authenticated ordinary user, a guest cookie, a forged identity header, or the checkout service bearer does not authorize a merchant read. The backend verifies the signed cookie, database session and linked GitHub identity on every request. Merchant sessions expire after eight hours; cookie caching and automatic extension are disabled.

`GET /v1/merchant/session` exposes the authorized user ID, role, enabled sign-in providers and whether Google is linked; it never exposes provider subject IDs, emails or credentials. `GET /v1/merchant/orders` returns minimal summaries, payment-status filters (`all`, `paid`, `pending`, `canceled`, `review`, `simulated`) and bounded keyset pagination. `GET /v1/merchant/orders/:id` returns an explicit projection of receipt fields. All responses are private/no-store. The only merchant order action is an audited Stripe-test payment recheck. Guest receipt ownership checks remain separate.

Orders sort by descending creation time and unique ID. Cursors preserve PostgreSQL microseconds and are bound to their filter; they do not convey access rights. Newer arrivals appear on refresh without offset-based page shifts. This is a live view, not a snapshot transaction spanning pages. Completed expired receipts stay hidden; unresolved Stripe records remain available.

Authentication has separate tables for merchant profiles, linked provider accounts, sessions, OAuth state and rate limits. Merchant profile names/emails and encrypted OAuth credentials are authentication data, never copied into order receipts; payment-check audit exposes only stable actor ID and a sanitized display name. The daily cleanup removes expired sessions and OAuth state plus rate-limit counters older than a day; it retains stable merchant identities. The fixed storefront origin and strict sign-in destinations prevent request headers from selecting OAuth return locations. Password signup and implicit account linking are disabled. Google enrollment requires an existing approved merchant session and a completed Google OAuth flow; the callback rechecks that same live session before attaching the verified Google subject. Google cannot create a merchant account. Additive migration `007_single_merchant_google.sql` enforces at most one Google identity per merchant even when valid linking callbacks arrive concurrently. Matching emails alone never link accounts, and linked Google sign-in retains the same internal merchant ID and audit attribution. Removing the underlying GitHub ID from the allowlist revokes merchant access through either provider.

See the [merchant setup and recovery runbook](docs/deployment.md#merchant-authentication-and-inbox). Disabling or misconfiguring this optional feature leaves guest checkout available and merchant reads closed.

## Google shopper accounts

Optional public shopper sign-in has its own Better Auth instance, PostgreSQL tables, independent signing secret and `joys_customer` cookie family. A shopper session never authorizes merchant reads or payment rechecks, even when the shopper uses the same Google account as a merchant. Both Google flows use the pinned library verifier for ID-token signature, issuer, audience and expiry, with a nonce bound to one-time OAuth state; unverified Google email is rejected. Only basic `openid`, `email` and `profile` scopes are requested. The application does not request Gmail or Drive access.

`GET /v1/customer/session` returns a safe display name, internal user ID and customer role. `GET /v1/customer/orders` lists only that customer's retained orders with bounded keyset pagination (`limit` and `cursor` only). `GET /v1/customer/orders/:id` returns the existing safe receipt projection. Missing, expired and other-customer receipts produce the same 404. These endpoints require a signed customer cookie independently of the checkout service bearer, and all responses are private/no-store.

Guest checkout stays available. For remote orders, the storefront forwards only the customer cookie family on order/session creation. The backend derives the customer ID from the live database session and stores it atomically with the first order reservation. Ownership is not accepted from request JSON, identity headers, email addresses or an old guest receipt. Existing guest orders are not backfilled. A retry with a different shopper identity (including switching between guest and signed-in) returns `409 CUSTOMER_CHECKOUT_CHANGED`; it cannot attach or transfer the original order. An expired customer session returns 401 before reservation instead of silently submitting as a guest.

Customer sessions last eight hours without automatic extension; sign-out immediately revokes the database session. Customer and merchant sign-out are independent. Order history follows the existing thirty-day resolved-receipt retention and retains unresolved Stripe records until resolution. Authentication cleanup removes expired customer sessions, OAuth state and old rate limits while retaining stable customer profiles and linked identities. Account deletion, guest-order claiming and authenticated payment resumption from another browser remain future work; the account receipt is read-only.

On **5 November 2026**, backend `10bdc21df7fa3a81b175117cbf658858838b9f0e` passed [verification and production migrations](https://github.com/joydas65/Ecommerce-Orders/actions/runs/41991688391), including **143 PostgreSQL tests**. The tests cover signed Google-token fixtures, rejected signatures/issuers/audiences/nonces, explicit merchant linking, cross-role denial, private order history, immutable ownership, retries and cleanup. The deployed service returned 200 for `/health` and `/api/customer-auth/ok`, and 401 for an anonymous customer-session request.

Google production setup is active with only `openid`, `email` and `profile` scopes. Client credentials and the independent customer signing secret are stored only in backend production. Both Google capabilities are enabled there and remain disabled by default and in previews. The dedicated Google project has billing disabled and no linked billing account; an automatic association during creation was removed during setup.

The matching [storefront release](https://github.com/joydas65/Ecommerce-Store/actions/runs/41992225871) passed 653 unit tests and 99 local browser tests; its [deployed gate](https://github.com/joydas65/Ecommerce-Store/actions/runs/41992493394) passed eight tests. Real Google shopper sign-in, a new signed-in $18.36 Stripe sandbox purchase, private order history, full receipt reload, and sign-out followed by denied account-receipt access passed. A fresh Google login restored the same paid order history. Existing guest orders were not imported. Real GitHub merchant sign-in remained working and could see the new paid test order; shopper sign-out did not revoke that separate merchant session.

**Pending owner confirmation and live acceptance:** explicit merchant Google linking, subsequent Google sign-in, merchant sign-out and unchanged merchant identity. Local fixtures and anonymous deployed checks do not establish those external OAuth outcomes. See the [storefront release evidence](https://github.com/joydas65/Ecommerce-Store/blob/main/docs/deployment.md#google-accounts) and [Google setup runbook](docs/deployment.md#google-sign-in-for-merchants-and-shoppers).

## Audited payment rechecks

`GET /v1/merchant/orders/:id/payment-checks` returns action eligibility and the latest twenty audit events, with `hasMore` when older events exist. `POST /v1/merchant/orders/:id/recheck-payment` accepts only `{requestId: UUID}`. It independently requires a valid merchant session and the exact configured storefront Origin. A guest/service bearer cannot authorize it. Only unresolved Stripe-test orders with an existing session qualify; it never creates or expires a Stripe session, captures money, refunds, or overrides provider evidence.

The backend commits a requested event and a 30-second lease before retrieval. Stable actor/order-scoped idempotency, PostgreSQL locks, and lease fencing handle concurrent clicks and crashed workers. New requests are limited to one per order every ten seconds and five per merchant per minute; replay and recovery retain the original key. The provider retrieval uses the existing four-second timeout without automatic network retries. Verified state transitions and the result audit commit in the same transaction; a concurrent webhook's resolved state wins. Replay returns the saved result event alongside the latest order state, so an earlier pending result cannot downgrade a newer paid receipt.

A successful HTTP response means the check result was saved, not that payment succeeded: `provider_unavailable`, `interrupted`, `pending`, and `review_required` are explicit outcomes. Transport/503 ambiguity retains the same request ID. An expired lease can be recovered with that key, or a new accepted request records the old attempt as interrupted. `409 PAYMENT_CHECK_IN_PROGRESS` and `429 PAYMENT_CHECK_RATE_LIMITED` include `error.retryAt`.

Events contain server-derived actor ID/display label, timestamp, outcome and the state observed while holding the order lock. A durable sequence orders timestamp ties. Application code only appends events; this is not tamper-proof or permanent storage. Events and request records follow order retention and cascade on cleanup; deleting a merchant identity does not erase retained audit attribution. Both newly paid and newly canceled orders receive thirty days of retention; repeated resolved reads/replays do not extend it. Unresolved records remain retained.

Real PostgreSQL tests cover concurrent clicks/webhooks, expired leases and stale workers, lost commit acknowledgments, result-audit rollback, provider mismatches/timeouts, authorization/CSRF, rate limits and audit retention. The storefront's separate local runner exercises the actual Stripe SDK against a loopback fixture; no test-provider bypass is shipped in runtime code.

## Deliberate tradeoffs

Two repositories expose a clear API and deployment boundary, with extra coordination when the contract changes. Node keeps setup small; PostgreSQL transactions and constraints make concurrency explicit. Stripe's external side effect cannot participate in the database transaction, so durable attempt identity, provider idempotency, fresh retrieval and review states handle uncertainty.

Free plans can pause at quotas and wake from idle. This is a personal portfolio demonstration, without commercial uptime promises. Shared service authentication requires coordinated rotation. Real commerce would still need inventory reservation, customer account lifecycle and recovery controls, real tax and shipping rules, fulfillment, refunds, monitoring and broader audited operations. Enabling live payments requires a separate design and hosting review; replacing a test key is deliberately rejected.
