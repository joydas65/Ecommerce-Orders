-- Generated for Better Auth 1.7.15; owned by the existing transactional migration runner.
create table "merchant_users" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" boolean not null, "image" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null);

create table "merchant_sessions" ("id" text not null primary key, "expiresAt" timestamptz not null, "token" text not null unique, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null, "ipAddress" text, "userAgent" text, "userId" text not null references "merchant_users" ("id") on delete cascade);

create table "merchant_accounts" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "merchant_users" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz, "scope" text, "password" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null);

create table "merchant_verifications" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" timestamptz not null, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null);

create table "merchant_rate_limits" ("id" text not null primary key, "key" text not null unique, "count" integer not null, "lastRequest" bigint not null);

create index "merchant_sessions_userId_idx" on "merchant_sessions" ("userId");

create index "merchant_accounts_userId_idx" on "merchant_accounts" ("userId");

create index "merchant_verifications_identifier_idx" on "merchant_verifications" ("identifier");
CREATE UNIQUE INDEX merchant_accounts_provider_identity ON merchant_accounts ("providerId", "accountId");
CREATE INDEX merchant_sessions_expiry ON merchant_sessions ("expiresAt");
CREATE INDEX merchant_verifications_expiry ON merchant_verifications ("expiresAt");
CREATE INDEX merchant_rate_limits_last_request ON merchant_rate_limits ("lastRequest");
