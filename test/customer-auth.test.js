import { after, before, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import pg from 'pg';
import { getMigrations } from 'better-auth/db/migration';
import { databaseConfig } from '../src/database.js';
import { migrate } from '../src/migrate.js';
import { createCustomerAuth, customerAuthConfiguration, customerAuthOptions, admitCustomerIdentity } from '../src/customer-auth.js';
import { createMerchantAuth } from '../src/merchant-auth.js';
import { seedCustomerSessions } from '../scripts/test/seed-customer-session.mjs';

const schema = `customer_auth_${randomUUID().replaceAll('-', '')}`;
const env = { CUSTOMER_AUTH_ENABLED: 'true', CUSTOMER_ALLOW_LOCAL_AUTH: 'true', CUSTOMER_TEST_FIXTURES: 'true',
  CUSTOMER_AUTH_URL: 'http://127.0.0.1:3100', CUSTOMER_AUTH_SECRET: randomBytes(32).toString('hex'),
  GOOGLE_CLIENT_ID: 'fixture-google.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'fixture-google-secret-at-least-20' };
const code = (value) => (error) => error.code === value;
const request = (cookie = '') => ({ headers: { cookie } });
let admin, pool, auth, fixtures, signingKey, publicKey;
before(async () => {
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.DATABASE_URL || 'invalid:').hostname), 'Customer auth tests require disposable loopback PostgreSQL.');
  env.DATABASE_URL = process.env.DATABASE_URL;
  const config = databaseConfig({ DATABASE_URL: env.DATABASE_URL });
  admin = new pg.Pool(config);
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({ ...config, options: `-c search_path=${schema}` });
  await migrate(pool);
  auth = createCustomerAuth({ pool, env });
  fixtures = await seedCustomerSessions({ pool, env });
  const keys = await generateKeyPair('RS256');
  signingKey = keys.privateKey;
  publicKey = { ...await exportJWK(keys.publicKey), kid: 'customer-test-signing', alg: 'RS256', use: 'sig' };
});
after(async () => {
  mock.restoreAll();
  if (pool) await pool.end();
  if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
});

test('customer auth is explicitly enabled and requires a separate secret and fixed origin', () => {
  assert.equal(createCustomerAuth({ pool, env: {} }), null);
  for (const override of [
    { CUSTOMER_AUTH_URL: 'http://remote.example' }, { CUSTOMER_AUTH_URL: 'https://example.test/path' },
    { CUSTOMER_AUTH_URL: 'https://name:password@example.test' }, { CUSTOMER_AUTH_URL: 'https://example.test?next=1' },
    { CUSTOMER_AUTH_SECRET: 'short' }, { ORDERS_API_SECRET: env.CUSTOMER_AUTH_SECRET }, { BETTER_AUTH_SECRET: env.CUSTOMER_AUTH_SECRET },
    { GOOGLE_CLIENT_ID: '' }, { GOOGLE_CLIENT_SECRET: '' }, { VERCEL: '1' }, { CUSTOMER_ALLOW_LOCAL_AUTH: '' },
  ]) assert.throws(() => customerAuthConfiguration({ ...env, ...override }));
});

test('customer admission requires verified Google subject and email, never a client role or other provider', () => {
  const source = { oauth: { providerId: 'google', profile: { sub: '104295476783297806001', email: 'shopper@example.test', email_verified: true } } };
  assert.equal(admitCustomerIdentity(source), undefined);
  for (const changed of [undefined, {}, { oauth: { ...source.oauth, providerId: 'github' } },
    ...[{ sub: '' }, { sub: 123 }, { sub: 'a'.repeat(256) }, { email_verified: 'true' }, { email_verified: false }, { email: '' }]
      .map((value) => ({ oauth: { ...source.oauth, profile: { ...source.oauth.profile, ...value, role: 'merchant' } } })),
  ]) assert.equal(admitCustomerIdentity(changed).error, 'customer_access_denied');
});

test('customer SQL exactly supports the pinned Better Auth schema', async () => {
  const plan = await getMigrations(customerAuthOptions(pool, customerAuthConfiguration(env)));
  for (const key of ['toBeCreated', 'toBeAdded', 'toBeAddedIndexes', 'schemaProblems']) assert.deepEqual(plan[key], []);
});

test('real signed customer sessions verify identity without granting merchant access', async () => {
  assert.deepEqual(await auth.authorize(request(fixtures.customer.cookie)), { userId: fixtures.customer.userId, role: 'customer', displayName: 'Local customer' });
  await assert.rejects(auth.authorize(request()), code('AUTH_REQUIRED'));
  const merchant = createMerchantAuth({ pool, env: { MERCHANT_AUTH_ENABLED: 'true', MERCHANT_ALLOW_LOCAL_AUTH: 'true',
    BETTER_AUTH_URL: env.CUSTOMER_AUTH_URL, BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
    GITHUB_CLIENT_ID: 'fixture-github', GITHUB_CLIENT_SECRET: 'fixture-github-secret-at-least-20', MERCHANT_GITHUB_IDS: '1234567' } });
  await assert.rejects(merchant.authorize(request(fixtures.customer.cookie)), code('AUTH_REQUIRED'));
  await assert.rejects(auth.authorize({ headers: { authorization: `Bearer ${env.CUSTOMER_AUTH_SECRET}`, 'x-customer-id': fixtures.customer.userId, 'x-guest-id': randomUUID() } }), code('AUTH_REQUIRED'));
});

test('customer sessions reject tampering, expiry and a removed verified Google identity', async () => {
  await assert.rejects(auth.authorize(request(fixtures.expiredCookie)), code('AUTH_REQUIRED'));
  await assert.rejects(auth.authorize(request(`${fixtures.customer.cookie}x`)), code('AUTH_REQUIRED'));
  await pool.query('UPDATE customer_accounts SET "providerId" = $1 WHERE "userId" = $2', ['github', fixtures.customer.userId]);
  try { await assert.rejects(auth.authorize(request(fixtures.customer.cookie)), code('AUTH_REQUIRED')); }
  finally { await pool.query('UPDATE customer_accounts SET "providerId" = $1 WHERE "userId" = $2', ['google', fixtures.customer.userId]); }
  await pool.query('UPDATE customer_users SET "emailVerified" = false WHERE id = $1', [fixtures.customer.userId]);
  try { await assert.rejects(auth.authorize(request(fixtures.customer.cookie)), code('AUTH_REQUIRED')); }
  finally { await pool.query('UPDATE customer_users SET "emailVerified" = true WHERE id = $1', [fixtures.customer.userId]); }
});

test('session reads do not refresh expiry and fail closed on database errors', async () => {
  const before = (await pool.query('SELECT "expiresAt", "updatedAt" FROM customer_sessions WHERE id = $1', [fixtures.customer.sessionId])).rows[0];
  await auth.authorize(request(fixtures.customer.cookie));
  const after = (await pool.query('SELECT "expiresAt", "updatedAt" FROM customer_sessions WHERE id = $1', [fixtures.customer.sessionId])).rows[0];
  assert.deepEqual(after, before);
  const query = pool.query.bind(pool);
  const failure = mock.method(pool, 'query', (sql, ...args) => {
    if (typeof sql === 'string' && sql.startsWith('SELECT "accountId"')) throw new Error('private database details');
    return query(sql, ...args);
  });
  try { await assert.rejects(auth.authorize(request(fixtures.customer.cookie)), (error) => error.code === 'CUSTOMER_UNAVAILABLE' && !error.message.includes('private')); }
  finally { failure.mock.restore(); }
});

async function beginOAuth(instance = auth, ip = '192.0.2.110') {
  const response = await instance.handler(new Request(`${instance.origin}/api/customer-auth/sign-in/social`, {
    method: 'POST', headers: { origin: instance.origin, 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ provider: 'google', callbackURL: '/account', errorCallbackURL: '/account/sign-in' }),
  }));
  assert.equal(response.status, 200);
  const destination = new URL((await response.json()).url);
  assert.equal(destination.origin, 'https://accounts.google.com');
  assert.equal(destination.pathname, '/o/oauth2/v2/auth');
  assert.equal(destination.searchParams.get('redirect_uri'), `${instance.origin}/api/customer-auth/callback/google`);
  assert.equal(destination.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(destination.searchParams.get('code_challenge'));
  assert.ok(destination.searchParams.get('nonce'));
  assert.deepEqual(new Set(destination.searchParams.get('scope').split(' ')), new Set(['openid', 'email', 'profile']));
  assert.equal(destination.searchParams.get('include_granted_scopes'), null);
  return { state: destination.searchParams.get('state'), nonce: destination.searchParams.get('nonce'),
    cookies: response.headers.getSetCookie().map((cookie) => cookie.split(';')[0]).join('; '), ip };
}
async function providerMock(attempt, override = {}) {
  const token = await new SignJWT({ email: 'google-shopper@example.test', email_verified: true, name: 'Google Shopper', nonce: attempt.nonce, ...override })
    .setProtectedHeader({ alg: 'RS256', kid: publicKey.kid }).setIssuer('https://accounts.google.com')
    .setAudience(env.GOOGLE_CLIENT_ID).setSubject('google-test-subject-001').setIssuedAt().setExpirationTime('1h').sign(signingKey);
  return mock.method(globalThis, 'fetch', async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'fixture-google-access-token', id_token: token, token_type: 'Bearer', expires_in: 3600, scope: 'openid email profile' });
    if (url === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json({ keys: [publicKey] });
    throw new Error('Unexpected OAuth provider request');
  });
}
function callback(instance, attempt) {
  return instance.handler(new Request(`${instance.origin}/api/customer-auth/callback/google?code=fixture-code&state=${encodeURIComponent(attempt.state)}`, { headers: { cookie: attempt.cookies, 'x-forwarded-for': attempt.ip } }));
}

test('Google OAuth verifies state, PKCE and token claims, persists subject and encrypts credentials', async () => {
  const production = createCustomerAuth({ pool, env: { ...env, CUSTOMER_AUTH_URL: 'https://store.example.test', VERCEL: '1' } });
  const attempt = await beginOAuth(production, '192.0.2.111');
  const provider = await providerMock(attempt);
  try {
    const response = await callback(production, attempt);
    assert.equal(response.status, 302);
    assert.equal(new URL(response.headers.get('location'), production.origin).href, `${production.origin}/account`);
    const sessionCookie = response.headers.getSetCookie().find((cookie) => cookie.startsWith('__Secure-joys_customer.session_token='));
    assert.ok(sessionCookie); assert.match(sessionCookie, /HttpOnly/i); assert.match(sessionCookie, /Secure/i); assert.match(sessionCookie, /SameSite=Lax/i);
    assert.doesNotMatch(sessionCookie, /Domain=/i); assert.match(sessionCookie, /Max-Age=28800/i);
    const identity = await production.authorize(request(sessionCookie.split(';')[0]));
    const account = (await pool.query('SELECT "accessToken", "accountId" FROM customer_accounts WHERE "userId" = $1', [identity.userId])).rows[0];
    assert.equal(account.accountId, 'google-test-subject-001');
    assert.ok(account.accessToken); assert.notEqual(account.accessToken, 'fixture-google-access-token');
    assert.equal((await pool.query('SELECT count(*)::int count FROM merchant_users WHERE email = $1', ['google-shopper@example.test'])).rows[0].count, 0);
    const replay = await callback(production, attempt);
    assert.match(replay.headers.get('location'), /error=/);
  } finally { provider.mock.restore(); }
});

test('unverified Google email is rejected before customer account creation', async () => {
  const attempt = await beginOAuth(auth, '192.0.2.112');
  const provider = await providerMock(attempt, { email_verified: false, email: 'unverified@example.test' });
  try {
    const response = await callback(auth, attempt);
    assert.equal(response.status, 302);
    assert.match(response.headers.get('location'), /error=unable_to_get_user_info/);
    assert.equal((await pool.query('SELECT count(*)::int count FROM customer_users WHERE email = $1', ['unverified@example.test'])).rows[0].count, 0);
  } finally { provider.mock.restore(); }
});

test('unexpected OAuth database errors expose neither raw adapter metadata nor console logs', async () => {
  for (const errorCode of ['08006', '23505']) {
    const attempt = await beginOAuth(auth, errorCode === '08006' ? '192.0.2.118' : '192.0.2.119');
    const provider = await providerMock(attempt);
    const originalConnect = pool.connect.bind(pool);
    let injected = false;
    // Better Auth's SQL adapter acquires a PoolClient directly, so inject at
    // that actual adapter boundary rather than at the service's pool.query.
    const adapter = mock.method(pool, 'connect', async () => {
      const client = await originalConnect();
      return new Proxy(client, { get(target, key) {
        if (key === 'query') return (sql, ...args) => {
          const text = typeof sql === 'string' ? sql : sql?.text;
          if (typeof text === 'string' && /^update /i.test(text) && text.includes('customer_accounts')) {
            injected = true;
            throw Object.assign(new Error('private SQL metadata with google-shopper@example.test'), {
              code: errorCode, detail: 'raw Google subject and token must not leak', table: 'customer_accounts',
            });
          }
          return target.query(sql, ...args);
        };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    });
    const consoleError = mock.method(console, 'error', () => {});
    const consoleWarn = mock.method(console, 'warn', () => {});
    try {
      const response = await callback(auth, attempt);
      assert.equal(injected, true);
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: { code: 'CUSTOMER_UNAVAILABLE', message: 'Customer sign-in is temporarily unavailable.' } });
      assert.equal(response.headers.getSetCookie().length, 0);
      assert.equal(consoleError.mock.calls.length, 0);
      assert.equal(consoleWarn.mock.calls.length, 0);
    } finally { consoleError.mock.restore(); consoleWarn.mock.restore(); adapter.mock.restore(); provider.mock.restore(); }
  }
});

test('OAuth rejects cross-origin/same-site POSTs, external callbacks and missing state', async () => {
  for (const headers of [{ origin: 'https://attacker.example' }, { origin: auth.origin, 'sec-fetch-site': 'same-site' }]) {
    const response = await auth.handler(new Request(`${auth.origin}/api/customer-auth/sign-in/social`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'x-forwarded-for': '192.0.2.113' },
      body: JSON.stringify({ provider: 'google', callbackURL: '/account' }),
    }));
    assert.equal(response.status, 403);
  }
  const response = await auth.handler(new Request(`${auth.origin}/api/customer-auth/sign-in/social`, {
    method: 'POST', headers: { origin: auth.origin, 'content-type': 'application/json', 'x-forwarded-for': '192.0.2.114' },
    body: JSON.stringify({ provider: 'google', callbackURL: 'https://attacker.example' }),
  }));
  assert.equal(response.status, 403);
  const attempt = await beginOAuth(auth, '192.0.2.115');
  attempt.cookies = '';
  assert.match((await callback(auth, attempt)).headers.get('location'), /error=/);
});

test('persistent customer login rate limits survive a fresh auth instance', async () => {
  for (let i = 0; i < 10; i++) await beginOAuth(auth, '192.0.2.116');
  const restarted = createCustomerAuth({ pool, env });
  const response = await restarted.handler(new Request(`${auth.origin}/api/customer-auth/sign-in/social`, {
    method: 'POST', headers: { origin: auth.origin, 'content-type': 'application/json', 'x-forwarded-for': '192.0.2.116' },
    body: JSON.stringify({ provider: 'google', callbackURL: '/account' }),
  }));
  assert.equal(response.status, 429);
});

test('customer sign-out revokes the database session and fixture seeding is strictly local', async () => {
  const response = await auth.handler(new Request(`${auth.origin}/api/customer-auth/sign-out`, {
    method: 'POST', headers: { cookie: fixtures.customer.cookie, origin: auth.origin, 'content-type': 'application/json', 'x-forwarded-for': '192.0.2.117' }, body: '{}',
  }));
  assert.equal(response.status, 200);
  await assert.rejects(auth.authorize(request(fixtures.customer.cookie)), code('AUTH_REQUIRED'));
  for (const override of [{ VERCEL: '1' }, { DATABASE_URL: 'postgres://user:password@remote.example/orders' }, { CUSTOMER_TEST_FIXTURES: '' }]) {
    await assert.rejects(seedCustomerSessions({ pool, env: { ...env, ...override } }), /fixtures require/i);
  }
});
