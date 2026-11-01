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
NEXT_PUBLIC_COMMERCE_MODE=demo
NEXT_PUBLIC_DEMO_ORDER_STORAGE=remote
ORDERS_API_URL=https://<verified-orders-production-domain>
ORDERS_API_SECRET=<same backend service secret>
```

Redeploy the storefront because the demo-storage switch is a build-time value. Keep previews in local demo mode. Backend previews intentionally have no production database or service secret, and authenticated order operations fail closed. A future functional preview environment needs its own database and its own secrets.

The backend production domain must be accessible to the storefront server. Keep the application's bearer authentication enabled even if Vercel deployment protection is changed. Anonymous callers may read `/health`; quote/order/receipt routes require `ORDERS_API_SECRET`, and `/internal/cleanup` requires the separate `CRON_SECRET`.

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

The script rejects an unexpected host, credentials in the URL and automatic redirects. It verifies unauthenticated rejection, price/shipping, order persistence, idempotent replay, receipt loading and another guest's access denial. It prints no credentials, request bodies or guest IDs and creates only a synthetic demo receipt. It deliberately fails on a deployment-protection login page.

Then complete a purchase in the storefront, reload its receipt and open the same receipt URL in a separate browser session. Confirm the receipt survives a backend redeploy and the second session cannot access it. A backend failure must preserve the cart and must not display a success confirmation.

## Retention, investigation and recovery

The configured daily cron calls `/internal/cleanup` during the 04:00 UTC hour. Vercel sends `CRON_SECRET` as a bearer token. Cleanup is safe to repeat; reads enforce expiry independently. Hobby cron is best effort and failed runs are not automatically retried, so inspect failures before relying on cleanup. `npm run cleanup` offers an authenticated-operator recovery path with the database URL supplied privately. [Cron authentication and behavior](https://vercel.com/docs/cron-jobs/manage-cron-jobs).

Use request IDs and sanitized status/duration logs to investigate failures. Do not log bearer tokens, database URLs, guest cookies or order request bodies. Free-plan log retention is short; a durable observability pipeline is a future decision rather than an implied feature.

For code rollback, choose the last verified production deployment in Vercel and roll back to that deployment. Check schema compatibility and run the smoke again. Re-enable normal promotion only after checks pass. Restoring database data is separate: Neon Free has a short recovery window and no uptime SLA, so validate a restore procedure before claiming a recovery objective.

When rotating `ORDERS_API_SECRET`, update backend and storefront in a coordinated maintenance window and redeploy both. The current single-secret design does not offer overlapping old/new keys, so temporary checkout failures are possible during rotation. Rotate `CRON_SECRET` separately on the backend.

No payment processor, money movement, fulfillment, stock reservation or refund workflow is configured. Order data is synthetic; these operational controls do not make the demo a live commerce service.
