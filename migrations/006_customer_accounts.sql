-- Generated for Better Auth 1.7.15; owned by the existing transactional migration runner.
create table "customer_users" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" boolean not null, "image" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null);

create table "customer_sessions" ("id" text not null primary key, "expiresAt" timestamptz not null, "token" text not null unique, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null, "ipAddress" text, "userAgent" text, "userId" text not null references "customer_users" ("id") on delete cascade);

create table "customer_accounts" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "customer_users" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz, "scope" text, "password" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null);

create table "customer_verifications" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" timestamptz not null, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null);

create table "customer_rate_limits" ("id" text not null primary key, "key" text not null unique, "count" integer not null, "lastRequest" bigint not null);

create index "customer_sessions_userId_idx" on "customer_sessions" ("userId");

create index "customer_accounts_userId_idx" on "customer_accounts" ("userId");

create index "customer_verifications_identifier_idx" on "customer_verifications" ("identifier");
CREATE UNIQUE INDEX customer_accounts_provider_identity ON customer_accounts ("providerId", "accountId");
CREATE INDEX customer_sessions_expiry ON customer_sessions ("expiresAt");
CREATE INDEX customer_verifications_expiry ON customer_verifications ("expiresAt");
CREATE INDEX customer_rate_limits_last_request ON customer_rate_limits ("lastRequest");

-- Account ownership is captured atomically at the first order reservation.
-- Existing guest orders are intentionally not backfilled by email or browser identity.
ALTER TABLE orders ADD COLUMN customer_user_id text REFERENCES customer_users(id) ON DELETE SET NULL;
CREATE INDEX orders_customer_created ON orders (customer_user_id, created_at DESC, id DESC) WHERE customer_user_id IS NOT NULL;
