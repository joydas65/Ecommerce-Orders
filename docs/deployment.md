# Deployment and recovery

The backend repository is `joydas65/Ecommerce-Orders`; the Vercel project is `joys-orders`. Keep the team on **Hobby** and the database on **Neon Free**. Review [free hosting limits](costs.md) before changing plans. Vercel's Git integration builds the code; GitHub verifies it and applies migrations. A build never runs a production migration.

## One-time configuration

1. Create/link the Vercel project with the GitHub repository, production branch `main`, Node.js 24, no framework preset, and region `iad1`. Use the checked-in `vercel.json`; only `public` is exposed as static content. Set `NODEJS_HELPERS=0` in all backend environments so the native handler reads and bounds the raw body stream itself. [Vercel Node helpers](https://vercel.com/docs/functions/runtimes/node-js/advanced-node-configuration#disabling-helpers-for-node.js).
2. Create a Neon **Free** project near `iad1`. Keep scale-to-zero enabled. Store its pooled TLS connection string as `DATABASE_URL` in the backend's **production** environment only.
3. Generate two independent random secrets, each from at least 32 bytes. Set backend production `ORDERS_API_SECRET` and `CRON_SECRET`. The storefront receives only the first, as a server-only variable. Do not place either secret in code, browser bundles, URLs or command logs.
4. Create the GitHub `production` environment with a deployment branch policy restricted to `main`. Store the migration connection string as its `DATABASE_URL` secret. No production credentials belong in pull request jobs or preview environments. Prefer a direct Neon connection for migrations and the pooled connection for runtime; the migrator uses a transaction-scoped advisory lock, so it does not depend on pooled session affinity.
5. In Vercel Deployment Checks, require the two exact GitHub job names **`Orders verification`** and **`Orders production migration`**, with automatic production alias assignment enabled. The first workflow must run once before Vercel can discover its checks. Keep the first release unpromoted until these checks are configured and passing; do not use Force Promote to bypass them.

These account settings are part of the release setup, not something `vercel.json` alone enforces. A Git-connected project without required checks can promote before tests finish. [Vercel Deployment Checks](https://vercel.com/docs/deployment-checks).

For the first release, an authenticated operator may run `npm run migrate` once using the production database supplied through a protected environment. The subsequent CI migration is idempotent. Verify the account, project and database before any schema write; never print the database URL.

## Storefront production configuration

After the backend checks and first live smoke succeed, set the storefront's production variables:

```dotenv
NEXT_PUBLIC_CATALOG_PROVIDER=seeded
NEXT_PUBLIC_PAYMENT_PROVIDER=simulated
NEXT_PUBLIC_ORDER_STORAGE=remote
ORDERS_API_URL=https://<verified-orders-production-domain>
ORDERS_API_SECRET=<same backend service secret>
```

Redeploy the storefront because public capabilities are build-time values. Keep previews on seeded catalog, simulated payments and local order storage. Backend previews intentionally have no production database or service secret, and authenticated order operations fail closed. A future functional preview environment needs its own database and its own secrets.

The backend production domain must be accessible to the storefront server. Keep the application's bearer authentication enabled even if Vercel deployment protection is changed. Anonymous callers may read `/health`; quote/order/receipt routes require `ORDERS_API_SECRET`, and `/internal/cleanup` requires the separate `CRON_SECRET`. Stripe webhooks authenticate the untouched raw body using their own endpoint signing secret.

## Optional Stripe sandbox setup

The default profile remains simulated until a separate, tested activation. The following config enables **test-only** hosted payments; it does not make the store a live commerce service. Stripe test transactions do not move funds. Use synthetic customer details and Stripe's documented test cards, never real card details. [Stripe testing](https://docs.stripe.com/testing).

1. Use one Stripe sandbox throughout. Keep its `sk_test_...` key server-only on the orders backend. The runtime rejects live keys. There is no custom provider-host setting in production.
2. Configure a snapshot-event webhook for `https://<verified-orders-production-domain>/v1/webhooks/stripe`, using API version `2026-10-28.endive`. Subscribe to `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed` and `checkout.session.expired`. Save that endpoint's `whsec_...` signing secret on the backend only. Do not use a CLI listener's signing secret for a deployed endpoint.
3. Set backend production `STRIPE_PAYMENTS_ENABLED=true`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and `STOREFRONT_ORIGIN=https://<verified-storefront-production-domain>` only as part of the reviewed activation. Keep `NODEJS_HELPERS=0` before building. The origin must be fixed, with no path, credentials, query or fragment; request headers cannot choose a payment return destination.
4. Apply the additive payment migration and verify the backend before switching the storefront to `NEXT_PUBLIC_CATALOG_PROVIDER=seeded`, `NEXT_PUBLIC_PAYMENT_PROVIDER=stripe`, `NEXT_PUBLIC_ORDER_STORAGE=remote`. Both backend and storefront require new builds for their configuration. Keep database and payment secrets out of previews and GitHub jobs.
5. For the storefront deployment gate, set the repository variable `PAYMENT_PROVIDER=stripe` only when activating that production profile. With the variable absent, the gate still expects simulated checkout. Previews remain simulated regardless of this variable. Use a fresh commit when changing release configuration so old checks from the same commit cannot satisfy the new profile accidentally.

For local integration testing, use the local database, set `STOREFRONT_ORIGIN=http://127.0.0.1:3000`, and opt in with `ORDERS_ALLOW_LOCAL_STOREFRONT=true`. This HTTP exception is rejected on Vercel. A Stripe CLI listener can forward the four subscribed events to `http://127.0.0.1:4100/v1/webhooks/stripe`; use the listener's signing secret for that local process only. Load credentials through a private environment, never a committed file or command argument.

Verify one hosted sandbox payment with test data, then confirm the stored receipt, reload, duplicate-event behavior and foreign-guest denial. Also test returning without paying, cancellation, a delayed webhook and an ambiguous submission response. The query string `checkout=return` is not proof of payment: confirmation requires a fresh server-side Stripe retrieval with matching snapshot values. [Checkout fulfillment](https://docs.stripe.com/checkout/fulfillment), [Webhook signature verification](https://docs.stripe.com/events/manage-webhook-endpoints#signature-errors).

## Merchant authentication and inbox

This feature uses Better Auth inside the existing Node service and PostgreSQL database. It adds no hosted authentication subscription. Apply migrations `003_merchant_orders.sql` and `004_merchant_auth.sql` through the normal checked migration job. They add query indexes and independent auth tables without changing existing checkout records.

1. Register a GitHub OAuth App owned by the merchant. Set its homepage to the exact storefront origin and its authorization callback to `https://<storefront-origin>/api/auth/callback/github`. Local integration needs a separate local callback registration; do not point production login at a loopback URL.
2. On the **backend production project only**, set `MERCHANT_AUTH_ENABLED=true`, `BETTER_AUTH_URL=https://<storefront-origin>`, a new independent `BETTER_AUTH_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `MERCHANT_GITHUB_IDS`. The allowlist contains immutable numeric GitHub IDs, never emails, display names, client-submitted roles or the first account to sign in. The session secret must differ from `ORDERS_API_SECRET`.
3. Keep authentication disabled in previews without a separately isolated database and OAuth application. Local HTTP requires explicit `MERCHANT_ALLOW_LOCAL_AUTH=true` and a loopback origin; that exception is rejected on Vercel.
4. The storefront forwards only approved auth routes and auth cookies to the backend. GitHub OAuth tokens and the session signing secret never belong in storefront variables, browser code or CI. Preserve all `Set-Cookie` values on callbacks and sign-out. `/api/auth/(.*)` uses an unnamed Vercel rewrite so callback state is not polluted by synthetic query parameters.
5. Release the backward-compatible backend first, then the storefront. Verify authorized sign-in and inbox/detail reads, unauthorized rejection, filters and pagination, sign-out, and guest checkout. Verify audited rechecks separately; other unsupported mutation methods return 405. Inspect logs by request ID without logging OAuth codes, state, session cookies or identities.

The merchant routes authenticate a database-backed session independently of the checkout bearer. `/v1/merchant/session` exposes only user ID and role. Permissions are rechecked against the linked immutable GitHub identity on every merchant request; removing an ID from `MERCHANT_GITHUB_IDS` and deploying takes effect even for existing sessions. Revoking a database session immediately denies its cookie. Rotate the signing secret to invalidate all sessions; existing users can sign in again. Invalid auth configuration returns `MERCHANT_UNAVAILABLE` only for merchant/auth operations and does not disable checkout.

### Audited payment recheck activation and recovery

Apply additive migration `005_merchant_payment_checks.sql` through the checked migration job before deploying the recheck backend. It adds durable attempts and append-only application audit events; it changes no existing orders. Release the backward-compatible backend before the storefront. No new hosted resource, credential, or environment variable is required. Existing Stripe-test and merchant authentication settings must both be valid.

Verify an authorized check on an unresolved test order, pending and verified-paid outcomes, provider failure, request replay after a lost response, concurrent webhook resolution, audit reload and unauthorized/CSRF rejection. The public production gate verifies denial without storing a merchant session in CI. The storefront's loopback-only integration runner provides deterministic signed sessions and Stripe SDK responses for positive-path automation. Its seed helper accepts an optional UUID `MERCHANT_TEST_RUN_ID` to isolate rate-limit actors; it refuses Vercel, remote databases, missing explicit fixture opt-in, and non-fixture account replacement. Production runtime does not import the runner or fixture helper.

Each request uses one UUID generated before submission. Persist and reuse it after timeouts, 503, `PAYMENT_CHECK_IN_PROGRESS`, or response loss; a saved result always replays without another Stripe call and includes the current order. `409 PAYMENT_CHECK_IN_PROGRESS` and `429 PAYMENT_CHECK_RATE_LIMITED` carry `error.retryAt`. New checks have a ten-second per-order cooldown and a five-per-minute merchant limit. A requested event is committed before retrieval; final order state and result event commit together. A thirty-second lease can be recovered after a crash, with fencing preventing an older worker from writing over the replacement. The Stripe SDK has a four-second timeout and zero automatic retries. Initial session authorization covers the bounded in-flight action; the next request always revalidates session expiry and GitHub access.

HTTP 200 confirms the result was saved, not that Stripe paid the order. Inspect `check.outcome`: `provider_unavailable` means no provider evidence could be retrieved, and `interrupted` means no verified result was saved for an abandoned/replaced attempt. Neither is payment success. `already_resolved` preserves a webhook's terminal state. Mismatched/live-mode evidence becomes review, never paid. The action only retrieves an existing session; it cannot create or expire one, refund, fulfill, or force a status. Missing-session orders require investigation through the existing checkout recovery path.

History returns the latest twenty events and `hasMore`; there is no audit export or older-history pagination in this increment. Event actor labels come from persisted merchant profiles and are sanitized; emails, OAuth tokens, guest IDs, provider IDs/URLs and request headers are excluded. Events are append-only through application code, not tamper-proof against database administrators. Merchant identity deletion preserves attribution text. Order cleanup removes its events and request keys. Newly verified cancellation, like payment, starts a thirty-day resolved retention window, including an order older than its original expiry; repeated resolved events do not extend it.

## Release sequence

1. On each pull request or main push, `Orders verification` installs locked dependencies, checks syntax, runs tests against an isolated PostgreSQL service, runs release-script tests and audits production dependencies. It has read-only GitHub permissions and no production credentials.
2. On `main` only, `Orders production migration` waits for verification, checks the commit is still the main branch head and applies tracked migrations using the production environment secret. Migrations take a PostgreSQL advisory transaction lock, record checksums and reject edits to already-applied files. Missing credentials or a failed migration fail this check.
3. Vercel builds independently, then the configured checks hold promotion until both jobs pass. The build does not receive a database migration command. No Vercel API token is required in GitHub.

Migrations must be additive and backward compatible because the currently serving deployment remains live while the migration runs. A successful migration followed by a failed build is possible; code rollback does not undo schema changes. Use expand/contract changes across releases, and do not edit applied migrations.

This first step does not claim an automated pre-promotion HTTP smoke for the backend. GitHub checks verify code and schema; use the supplied smoke command against the verified production origin after release, and the storefront's browser checks for the complete purchase flow.

## Verify a live release

Supply `ORDERS_API_SECRET` through an existing protected environment. Set `ORDERS_API_URL` to the verified production origin and `EXPECTED_ORDERS_HOST` to its exact hostname, then run:

```sh
node scripts/release/verify-production.mjs
```

This smoke verifies the simulated path, including when optional Stripe support is enabled. It does not prove Stripe payment integration. The script rejects an unexpected host, credentials in the URL and automatic redirects. It verifies unauthenticated rejection, price/shipping, order persistence, idempotent replay, receipt loading and another guest's access denial. It prints no credentials, request bodies or guest IDs and creates only a synthetic demo receipt. It deliberately fails on a deployment-protection login page.

The storefront Stripe production gate, when configured, creates one unpaid test session per test attempt, verifies its private pending receipt and cancels it. It never enters a card or claims payment completion. Local Stripe browser contract tests intercept the BFF and hosted page; those deterministic fixtures do not contact Stripe or PostgreSQL.

Then complete the selected checkout flow in the storefront, reload its receipt and open the same receipt URL in a separate browser session. Confirm the receipt survives a backend redeploy and the second session cannot access it. A backend failure must preserve the cart and must not display a success confirmation.

## Retention, investigation and recovery

The configured daily cron calls `/internal/cleanup` during the 04:00 UTC hour. Vercel sends `CRON_SECRET` as a bearer token. Cleanup is safe to repeat; reads enforce resolved-receipt expiry independently. Pending and review Stripe records are deliberately retained beyond their nominal expiry and excluded from cleanup, so unresolved payment evidence is not deleted. Inspect and reconcile unresolved attempts; the daily task does not reconcile payments. No automatic resolution deadline is promised. Hobby cron is best effort and failed runs are not automatically retried, so inspect failures before relying on cleanup. `npm run cleanup` offers an authenticated-operator recovery path with the database URL supplied privately. [Cron authentication and behavior](https://vercel.com/docs/cron-jobs/manage-cron-jobs).

The same cleanup also removes expired merchant sessions and OAuth state plus rate-limit counters older than one day; it retains merchant users and linked account identities.

Use request IDs and sanitized status/duration logs to investigate failures. Do not log bearer tokens, database URLs, guest cookies or order request bodies. Free-plan log retention is short; a durable observability pipeline is a future decision rather than an implied feature.

For code rollback, choose the last verified production deployment in Vercel and roll back to that deployment. Check schema compatibility and run the smoke again. Re-enable normal promotion only after checks pass. Restoring database data is separate: Neon Free has a short recovery window and no uptime SLA, so validate a restore procedure before claiming a recovery objective.

When rotating `ORDERS_API_SECRET`, update backend and storefront in a coordinated maintenance window and redeploy both. The current single-secret design does not offer overlapping old/new keys, so temporary checkout failures are possible during rotation. Rotate `CRON_SECRET` separately on the backend.

Stripe support is test-only. No real money movement, fulfillment, stock reservation or refund workflow is configured. The merchant inbox supports investigation and an audited retrieval-only recheck; only verified provider evidence can resolve a payment. These controls do not make the demo a live commerce service. Keep test webhook delivery enabled while unresolved attempts remain; disabling new checkout is different from discarding outstanding payment evidence.
