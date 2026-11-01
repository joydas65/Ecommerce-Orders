import { after, before, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { getMigrations } from 'better-auth/db/migration';
import { databaseConfig } from '../src/database.js';
import { migrate } from '../src/migrate.js';
import { createMerchantAuth, merchantAuthConfiguration, merchantAuthOptions, admitMerchantIdentity } from '../src/merchant-auth.js';
import { seedMerchantSessions } from '../scripts/test/seed-merchant-session.mjs';

const schema = `auth_test_${randomUUID().replaceAll('-', '')}`;
const env = { MERCHANT_AUTH_ENABLED: 'true', MERCHANT_ALLOW_LOCAL_AUTH: 'true', MERCHANT_TEST_FIXTURES: 'true',
  BETTER_AUTH_URL: 'http://127.0.0.1:3100', BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
  GITHUB_CLIENT_ID: 'fixture-client', GITHUB_CLIENT_SECRET: 'fixture-client-secret-at-least-20', MERCHANT_GITHUB_IDS: '123456789' };
let admin;
let pool;
let auth;
let fixtures;
const hasCode = (code) => (error) => error.code === code;
const asRequest = (cookie = '') => ({ headers: { cookie } });

before(async () => {
  const url = new URL(process.env.DATABASE_URL || 'invalid:');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Authentication tests require disposable loopback PostgreSQL.');
  env.DATABASE_URL = process.env.DATABASE_URL;
  const config = databaseConfig({ DATABASE_URL: env.DATABASE_URL });
  admin = new pg.Pool(config);
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({ ...config, options: `-c search_path=${schema}` });
  await migrate(pool);
  auth = createMerchantAuth({ pool, env });
  fixtures = await seedMerchantSessions({ pool, env });
});
after(async () => {
  mock.restoreAll();
  if (pool) await pool.end();
  if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
});

test('merchant auth is opt-in and enabled configuration requires fixed origin and independent secrets', () => {
  assert.equal(createMerchantAuth({ pool, env: {} }), null);
  assert.equal(merchantAuthConfiguration({ ...env, MERCHANT_AUTH_ENABLED: 'false' }), null);
  for (const changed of [
    { BETTER_AUTH_URL: 'http://untrusted.example' }, { BETTER_AUTH_URL: 'https://store.example/path' },
    { BETTER_AUTH_URL: 'https://user:pass@store.example' }, { BETTER_AUTH_URL: 'https://store.example?x=1' },
    { BETTER_AUTH_SECRET: 'short' }, { ORDERS_API_SECRET: env.BETTER_AUTH_SECRET },
    { GITHUB_CLIENT_ID: '' }, { GITHUB_CLIENT_SECRET: '' }, { MERCHANT_GITHUB_IDS: '' },
    { MERCHANT_GITHUB_IDS: 'joydas65' }, { MERCHANT_GITHUB_IDS: '123456789,' },
    { MERCHANT_GITHUB_IDS: '01' }, { VERCEL: '1' },
  ]) assert.throws(() => merchantAuthConfiguration({ ...env, ...changed }));
});

test('OAuth admission checks only the authenticated immutable GitHub identity', () => {
  const allowed = new Set(['123456789']);
  for (const id of [123456789, '123456789']) assert.equal(admitMerchantIdentity({ oauth: { providerId: 'github', profile: { id, email: 'changed@example.test' } } }, allowed), undefined);
  for (const source of [undefined, {}, { oauth: { providerId: 'google', profile: { id: '123456789' } } },
    { oauth: { providerId: 'github', profile: { id: '1', email: 'owner@example.test', role: 'merchant' } } },
    { oauth: { providerId: 'github', profile: { id: 123456789.1 } } },
    { oauth: { providerId: 'github', profile: { id: { toString: () => '123456789' } } } },
  ]) assert.equal(admitMerchantIdentity(source, allowed).error, 'merchant_access_denied');
});

test('versioned SQL exactly supports the pinned Better Auth configuration', async () => {
  const plan = await getMigrations(merchantAuthOptions(pool, merchantAuthConfiguration(env)));
  assert.deepEqual(plan.toBeCreated, []);
  assert.deepEqual(plan.toBeAdded, []);
  assert.deepEqual(plan.toBeAddedIndexes, []);
  assert.deepEqual(plan.schemaProblems, []);
});

test('real framework-signed sessions authorize merchants but reject other authenticated users', async () => {
  assert.deepEqual(await auth.authorize(asRequest(fixtures.merchant.cookie)), { userId: fixtures.merchant.userId, role: 'merchant' });
  await assert.rejects(auth.authorize(asRequest(fixtures.ordinary.cookie)), hasCode('MERCHANT_FORBIDDEN'));
  await assert.rejects(auth.authorize({ headers: { authorization: `Bearer ${env.BETTER_AUTH_SECRET}`, 'x-guest-id': randomUUID(), 'x-merchant-id': '123456789' } }), hasCode('AUTH_REQUIRED'));
  await assert.rejects(auth.authorize(asRequest()), hasCode('AUTH_REQUIRED'));
});

test('expired, tampered and unsigned cookies fail authentication', async () => {
  await assert.rejects(auth.authorize(asRequest(fixtures.expiredCookie)), hasCode('AUTH_REQUIRED'));
  const [name, value] = fixtures.merchant.cookie.split('=');
  const tampered = `${name}=${value.slice(0, 10)}x${value.slice(11)}`;
  await assert.rejects(auth.authorize(asRequest(tampered)), hasCode('AUTH_REQUIRED'));
  await assert.rejects(auth.authorize(asRequest(`${name}=made-up-session`)), hasCode('AUTH_REQUIRED'));
});

test('merchant role is reevaluated from persisted GitHub account on every read', async () => {
  await pool.query('UPDATE merchant_accounts SET "providerId" = $1 WHERE "userId" = $2', ['other-provider', fixtures.merchant.userId]);
  try { await assert.rejects(auth.authorize(asRequest(fixtures.merchant.cookie)), hasCode('MERCHANT_FORBIDDEN')); }
  finally { await pool.query('UPDATE merchant_accounts SET "providerId" = $1 WHERE "userId" = $2', ['github', fixtures.merchant.userId]); }
  const removed = createMerchantAuth({ pool, env: { ...env, MERCHANT_GITHUB_IDS: '12345678' } });
  await assert.rejects(removed.authorize(asRequest(fixtures.merchant.cookie)), hasCode('MERCHANT_FORBIDDEN'));
});

test('session authorization never refreshes expiry or emits a new session', async () => {
  const before = (await pool.query('SELECT "expiresAt", "updatedAt" FROM merchant_sessions WHERE id = $1', [fixtures.merchant.sessionId])).rows[0];
  await auth.authorize(asRequest(fixtures.merchant.cookie));
  const after = (await pool.query('SELECT "expiresAt", "updatedAt" FROM merchant_sessions WHERE id = $1', [fixtures.merchant.sessionId])).rows[0];
  assert.deepEqual(after, before);
});

test('database failures fail closed without exposing SQL or auth state', async () => {
  const query = pool.query.bind(pool);
  const mocked = mock.method(pool, 'query', (sql, ...args) => {
    if (typeof sql === 'string' && sql.startsWith('SELECT "accountId"')) throw new Error('sensitive database details');
    return query(sql, ...args);
  });
  try { await assert.rejects(auth.authorize(asRequest(fixtures.merchant.cookie)), (error) => error.code === 'MERCHANT_UNAVAILABLE' && !error.message.includes('sensitive')); }
  finally { mocked.mock.restore(); }
});

async function beginOAuth(authInstance = auth, ip = '192.0.2.80') {
  const response = await authInstance.handler(new Request(`${authInstance.origin}/api/auth/sign-in/social`, {
    method: 'POST', headers: { origin: authInstance.origin, 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ provider: 'github', callbackURL: '/admin/orders', errorCallbackURL: '/admin/sign-in' }),
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  const destination = new URL(body.url);
  assert.equal(destination.origin, 'https://github.com');
  assert.equal(destination.pathname, '/login/oauth/authorize');
  assert.equal(destination.searchParams.get('redirect_uri'), `${authInstance.origin}/api/auth/callback/github`);
  assert.equal(destination.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(destination.searchParams.get('code_challenge'));
  const cookies = response.headers.getSetCookie().map((cookie) => cookie.split(';')[0]).join('; ');
  assert.ok(cookies);
  return { state: destination.searchParams.get('state'), cookies };
}

function mockGitHub(id, email = 'oauth-merchant@example.test') {
  return mock.method(globalThis, 'fetch', async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: 'fixture-oauth-access-token', token_type: 'bearer', scope: 'read:user,user:email' });
    if (url === 'https://api.github.com/user') return Response.json({ id, login: 'fixture-login', name: 'Fixture merchant', email, avatar_url: null });
    if (url === 'https://api.github.com/user/emails') return Response.json([{ email, primary: true, verified: true }]);
    throw new Error(`Unexpected provider request: ${new URL(url).origin}`);
  });
}

test('GitHub OAuth admission rejects strangers before creating an account or session', async () => {
  const attempt = await beginOAuth();
  const provider = mockGitHub(88888888, 'stranger@example.test');
  try {
    const response = await auth.handler(new Request(`${auth.origin}/api/auth/callback/github?code=fixture-code&state=${encodeURIComponent(attempt.state)}`, { headers: { cookie: attempt.cookies, 'x-forwarded-for': '192.0.2.80' } }));
    assert.equal(response.status, 302);
    assert.match(response.headers.get('location'), /\/admin\/sign-in\?error=merchant_access_denied/);
    assert.equal((await pool.query('SELECT count(*)::int count FROM merchant_users WHERE email = $1', ['stranger@example.test'])).rows[0].count, 0);
  } finally { provider.mock.restore(); }
});

test('OAuth uses state and PKCE, creates a secure host-only session, and encrypts provider credentials', async () => {
  // Use a separate allowlisted identity so this flow does not depend on SQL-seeded fixtures.
  const production = createMerchantAuth({ pool, env: { ...env, BETTER_AUTH_URL: 'https://store.example.test', MERCHANT_GITHUB_IDS: '77777777', VERCEL: '1' } });
  const attempt = await beginOAuth(production, '192.0.2.81');
  const provider = mockGitHub(77777777);
  try {
    const response = await production.handler(new Request(`${production.origin}/api/auth/callback/github?code=fixture-code&state=${encodeURIComponent(attempt.state)}`, { headers: { cookie: attempt.cookies, 'x-forwarded-for': '192.0.2.81' } }));
    assert.equal(response.status, 302);
    assert.equal(new URL(response.headers.get('location'), production.origin).href, `${production.origin}/admin/orders`);
    const sessionCookie = response.headers.getSetCookie().find((cookie) => cookie.startsWith('__Secure-joys_merchant.session_token='));
    assert.ok(sessionCookie);
    assert.match(sessionCookie, /HttpOnly/i); assert.match(sessionCookie, /Secure/i); assert.match(sessionCookie, /SameSite=Lax/i);
    assert.doesNotMatch(sessionCookie, /Domain=/i);
    assert.match(sessionCookie, /Max-Age=28800/i);
    const identity = await production.authorize(asRequest(sessionCookie.split(';')[0]));
    const account = (await pool.query('SELECT "accessToken", "accountId" FROM merchant_accounts WHERE "userId" = $1', [identity.userId])).rows[0];
    assert.equal(account.accountId, '77777777');
    assert.ok(account.accessToken); assert.notEqual(account.accessToken, 'fixture-oauth-access-token');
    // The one-time OAuth state cannot be reused.
    const replay = await production.handler(new Request(`${production.origin}/api/auth/callback/github?code=fixture-code&state=${encodeURIComponent(attempt.state)}`, { headers: { cookie: attempt.cookies, 'x-forwarded-for': '192.0.2.81' } }));
    assert.match(replay.headers.get('location'), /error=state_mismatch|error=state_invalid|error=invalid_state/);
  } finally { provider.mock.restore(); }
});

test('OAuth rejects untrusted callbacks, origins, and missing state cookies', async () => {
  const malicious = await auth.handler(new Request(`${auth.origin}/api/auth/sign-in/social`, {
    method: 'POST', headers: { origin: auth.origin, 'content-type': 'application/json', 'x-forwarded-for': '192.0.2.82' },
    body: JSON.stringify({ provider: 'github', callbackURL: 'https://attacker.example' }),
  }));
  assert.equal(malicious.status, 403);
  const crossOrigin = await auth.handler(new Request(`${auth.origin}/api/auth/sign-in/social`, {
    method: 'POST', headers: { origin: 'https://attacker.example', 'content-type': 'application/json', 'x-forwarded-for': '192.0.2.82' },
    body: JSON.stringify({ provider: 'github', callbackURL: '/admin/orders' }),
  }));
  assert.equal(crossOrigin.status, 403);
  const attempt = await beginOAuth(auth, '192.0.2.83');
  const response = await auth.handler(new Request(`${auth.origin}/api/auth/callback/github?code=fixture-code&state=${encodeURIComponent(attempt.state)}`, { headers: { 'x-forwarded-for': '192.0.2.83' } }));
  assert.equal(response.status, 302);
  assert.match(response.headers.get('location'), /error=/);
});

test('database-backed login rate limits survive a fresh auth instance', async () => {
  for (let i = 0; i < 10; i++) await beginOAuth(auth, '192.0.2.90');
  const restarted = createMerchantAuth({ pool, env });
  const response = await restarted.handler(new Request(`${auth.origin}/api/auth/sign-in/social`, {
    method: 'POST', headers: { origin: auth.origin, 'content-type': 'application/json', 'x-forwarded-for': '192.0.2.90' },
    body: JSON.stringify({ provider: 'github', callbackURL: '/admin/orders' }),
  }));
  assert.equal(response.status, 429);
});

test('sign out revokes the database session immediately', async () => {
  const response = await auth.handler(new Request(`${auth.origin}/api/auth/sign-out`, {
    method: 'POST', headers: { cookie: fixtures.merchant.cookie, origin: auth.origin, 'content-type': 'application/json', 'x-forwarded-for': '192.0.2.91' }, body: '{}',
  }));
  assert.equal(response.status, 200);
  await assert.rejects(auth.authorize(asRequest(fixtures.merchant.cookie)), hasCode('AUTH_REQUIRED'));
  assert.equal((await pool.query('SELECT count(*)::int count FROM merchant_sessions WHERE id = $1', [fixtures.merchant.sessionId])).rows[0].count, 0);
});

test('session seeding refuses Vercel, remote databases, and absent explicit opt-in', async () => {
  for (const override of [{ VERCEL: '1' }, { DATABASE_URL: 'postgres://user:pass@remote.example/orders' }, { MERCHANT_TEST_FIXTURES: '' }]) {
    await assert.rejects(seedMerchantSessions({ pool, env: { ...env, ...override } }), /fixtures require/i);
  }
});
