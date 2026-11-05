import { after, before, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
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


const googleCredentials = { MERCHANT_GOOGLE_ENABLED: 'true', GOOGLE_CLIENT_ID: 'fixture-google-client.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'fixture-google-secret-at-least-20' };
const googleKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const googleJwk = { ...googleKeys.publicKey.export({ format: 'jwk' }), kid: 'merchant-google-test', alg: 'RS256', use: 'sig' };

async function googleFixture(extra = {}) {
  const fixtureEnv = { ...env, ...googleCredentials, MERCHANT_GITHUB_IDS: `8${randomBytes(5).readUIntBE(0, 5)}`, MERCHANT_TEST_RUN_ID: randomUUID(), ...extra };
  const seeded = await seedMerchantSessions({ pool, env: fixtureEnv });
  return { env: fixtureEnv, auth: createMerchantAuth({ pool, env: fixtureEnv }), ...seeded };
}

let googleAttemptNumber = 100;
async function beginGoogle(g, { link = true, cookie = link ? g.merchant.cookie : '', body = {}, ip = `192.0.2.${googleAttemptNumber++}` } = {}) {
  const result = await g.auth.handler(new Request(`${g.auth.origin}/api/auth/${link ? 'link-social' : 'sign-in/social'}`, {
    method: 'POST', headers: { origin: g.auth.origin, cookie, 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ provider: 'google', callbackURL: '/admin/orders', errorCallbackURL: '/admin/sign-in', ...body }),
  }));
  assert.equal(result.status, 200, await result.clone().text());
  const target = new URL((await result.json()).url);
  assert.equal(target.origin, 'https://accounts.google.com');
  assert.equal(target.pathname, '/o/oauth2/v2/auth');
  assert.equal(target.searchParams.get('redirect_uri'), `${g.auth.origin}/api/auth/callback/google`);
  assert.deepEqual(target.searchParams.get('scope').split(' ').sort(), ['email', 'openid', 'profile']);
  assert.equal(target.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(target.searchParams.get('code_challenge'));
  assert.equal(target.searchParams.get('access_type'), 'online');
  assert.ok(target.searchParams.get('nonce'));
  assert.equal(target.searchParams.get('include_granted_scopes'), null);
  return { state: target.searchParams.get('state'), nonce: target.searchParams.get('nonce'), cookies: result.headers.getSetCookie().map((value) => value.split(';')[0]).join('; '), cookie };
}

function signedGoogleToken(attempt, { sub = `google-${randomUUID()}`, email = 'approved-google@example.test', verified = true, claims = {}, badSignature = false } = {}) {
  const payload = { iss: 'https://accounts.google.com', aud: googleCredentials.GOOGLE_CLIENT_ID, sub, email, email_verified: verified, name: 'Google merchant', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, ...(attempt.nonce ? { nonce: attempt.nonce } : {}), ...claims };
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'RS256', kid: googleJwk.kid, typ: 'JWT' })}.${encode(payload)}`;
  const signature = sign('RSA-SHA256', Buffer.from(unsigned), googleKeys.privateKey).toString('base64url');
  const idToken = `${unsigned}.${badSignature ? `${signature[0] === 'a' ? 'b' : 'a'}${signature.slice(1)}` : signature}`;
  return { idToken, sub };
}

function mockGoogle(attempt, options) {
  const { idToken, sub } = signedGoogleToken(attempt, options);
  const requests = [];
  const provider = mock.method(globalThis, 'fetch', async (input, options) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requests.push({ url, body: options?.body });
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'fixture-google-access-token', id_token: idToken, token_type: 'Bearer', expires_in: 300, scope: 'openid email profile' });
    if (url === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json({ keys: [googleJwk] });
    throw new Error(`Unexpected provider request: ${new URL(url).origin}`);
  });
  return { provider, requests, sub };
}

function finishGoogle(g, attempt, cookie = attempt.cookie, code = 'fixture-code') {
  return g.auth.handler(new Request(`${g.auth.origin}/api/auth/callback/google?code=${encodeURIComponent(code)}&state=${encodeURIComponent(attempt.state)}`, {
    headers: { cookie: [attempt.cookies, cookie].filter(Boolean).join('; '), 'x-forwarded-for': '192.0.2.201' },
  }));
}

async function linkGoogle(g, options) {
  const attempt = await beginGoogle(g);
  const fixture = mockGoogle(attempt, options);
  try {
    const response = await finishGoogle(g, attempt);
    assert.equal(response.status, 302);
    assert.equal(new URL(response.headers.get('location'), g.auth.origin).href, `${g.auth.origin}/admin/orders`);
    return { sub: fixture.sub, attempt };
  } finally { fixture.provider.mock.restore(); }
}

test('Google is optional and its enabled configuration validates credentials without changing GitHub requirements', () => {
  assert.deepEqual(createMerchantAuth({ pool, env }).enabledProviders, ['github']);
  assert.equal(merchantAuthOptions(pool, merchantAuthConfiguration(env)).account.accountLinking.enabled, false);
  const config = merchantAuthConfiguration({ ...env, ...googleCredentials });
  assert.equal(config.google.clientId, googleCredentials.GOOGLE_CLIENT_ID);
  assert.deepEqual(createMerchantAuth({ pool, env: { ...env, ...googleCredentials } }).enabledProviders, ['github', 'google']);
  for (const extra of [{ GOOGLE_CLIENT_ID: '' }, { GOOGLE_CLIENT_ID: 'not-google' }, { GOOGLE_CLIENT_SECRET: '' }, { MERCHANT_GITHUB_IDS: '' }]) assert.throws(() => merchantAuthConfiguration({ ...env, ...googleCredentials, ...extra }));
  const options = merchantAuthOptions(pool, config);
  assert.equal(options.socialProviders.google.disableSignUp, true);
  assert.equal(options.account.accountLinking.disableImplicitLinking, true);
  assert.equal(options.account.accountLinking.allowDifferentEmails, true);
});

test('Google linking requires a live authorized merchant cookie, exact origin, and a bounded provider-only request', async () => {
  const g = await googleFixture();
  for (const [cookie, expected] of [['', 401], [g.ordinary.cookie, 403], [g.expiredCookie, 401], [g.merchant.cookie.replace('joys_merchant.', 'joys_customer.'), 401]]) {
    const response = await g.auth.handler(new Request(`${g.auth.origin}/api/auth/link-social`, {
      method: 'POST', headers: { origin: g.auth.origin, cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'google', callbackURL: '/admin/orders', errorCallbackURL: '/admin/sign-in' }),
    }));
    assert.equal(response.status, expected);
  }
  for (const extra of [{ provider: 'github' }, { scopes: ['https://www.googleapis.com/auth/drive'] }, { idToken: { token: 'untrusted' } }, { callbackURL: 'https://attacker.example' }]) {
    const response = await g.auth.handler(new Request(`${g.auth.origin}/api/auth/link-social`, {
      method: 'POST', headers: { origin: g.auth.origin, cookie: g.merchant.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'google', callbackURL: '/admin/orders', errorCallbackURL: '/admin/sign-in', ...extra }),
    }));
    assert.equal(response.status, 400);
  }
  for (const changed of [{ origin: 'https://attacker.example' }, { 'sec-fetch-site': 'same-site' }, { 'sec-fetch-site': 'cross-site' }]) {
    const response = await g.auth.handler(new Request(`${g.auth.origin}/api/auth/link-social`, {
      method: 'POST', headers: { origin: g.auth.origin, cookie: g.merchant.cookie, 'content-type': 'application/json', ...changed },
      body: JSON.stringify({ provider: 'google', callbackURL: '/admin/orders', errorCallbackURL: '/admin/sign-in' }),
    }));
    assert.equal(response.status, 403);
  }
});

test('explicit verified Google linking preserves the merchant identity and allows a different email without implicit linking', async () => {
  const g = await googleFixture();
  const before = (await pool.query('SELECT id,email FROM merchant_users WHERE id=$1', [g.merchant.userId])).rows[0];
  assert.deepEqual(await g.auth.accountStatus(asRequest(g.merchant.cookie)), { googleEnabled: true, googleLinked: false });
  const { sub } = await linkGoogle(g, { email: 'different-google-email@example.test' });
  assert.deepEqual((await pool.query('SELECT id,email FROM merchant_users WHERE id=$1', [g.merchant.userId])).rows[0], before);
  const accounts = (await pool.query('SELECT "userId","accountId","accessToken" FROM merchant_accounts WHERE "providerId"=$1 AND "accountId"=$2', ['google', sub])).rows;
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].userId, g.merchant.userId);
  assert.notEqual(accounts[0].accessToken, 'fixture-google-access-token');
  assert.deepEqual(await g.auth.accountStatus(asRequest(g.merchant.cookie)), { googleEnabled: true, googleLinked: true });
});

test('Google sign-in accepts only an explicitly linked identity and retains the stable merchant audit actor', async () => {
  const g = await googleFixture();
  const { sub } = await linkGoogle(g);
  const attempt = await beginGoogle(g, { link: false });
  const fixture = mockGoogle(attempt, { sub });
  try {
    const response = await finishGoogle(g, attempt);
    assert.equal(response.status, 302);
    assert.equal(new URL(response.headers.get('location'), g.auth.origin).href, `${g.auth.origin}/admin/orders`);
    const cookie = response.headers.getSetCookie().find((value) => value.startsWith('joys_merchant.session_token=')).split(';')[0];
    assert.deepEqual(await g.auth.authorize(asRequest(cookie)), { userId: g.merchant.userId, role: 'merchant' });
    const revoked = createMerchantAuth({ pool, env: { ...g.env, MERCHANT_GITHUB_IDS: '12345678' } });
    await assert.rejects(revoked.authorize(asRequest(cookie)), hasCode('MERCHANT_FORBIDDEN'));
  } finally { fixture.provider.mock.restore(); }
});

test('Google sign-in never creates a merchant or links by matching an existing merchant email', async () => {
  const g = await googleFixture();
  const email = (await pool.query('SELECT email FROM merchant_users WHERE id=$1', [g.merchant.userId])).rows[0].email;
  for (const candidate of [email, 'unknown-google-user@example.test']) {
    const attempt = await beginGoogle(g, { link: false });
    const fixture = mockGoogle(attempt, { email: candidate });
    try {
      const response = await finishGoogle(g, attempt);
      assert.match(response.headers.get('location'), /error=/);
      assert.equal((await pool.query('SELECT count(*)::int count FROM merchant_accounts WHERE "providerId"=$1 AND "accountId"=$2', ['google', fixture.sub])).rows[0].count, 0);
    } finally { fixture.provider.mock.restore(); }
  }
});

test('Google linking fails if the merchant session disappears or switches users during OAuth', async () => {
  const g = await googleFixture();
  for (const cookie of ['', g.ordinary.cookie, g.expiredCookie]) {
    const attempt = await beginGoogle(g);
    const fixture = mockGoogle(attempt);
    try {
      const response = await finishGoogle(g, attempt, cookie);
      assert.match(response.headers.get('location'), /error=/);
      assert.equal((await pool.query('SELECT count(*)::int count FROM merchant_accounts WHERE "providerId"=$1 AND "accountId"=$2', ['google', fixture.sub])).rows[0].count, 0);
    } finally { fixture.provider.mock.restore(); }
  }
});

test('GitHub approval revocation during OAuth prevents Google binding and future Google sign-in', async () => {
  const g = await googleFixture();
  const attempt = await beginGoogle(g);
  const fixture = mockGoogle(attempt);
  const revoked = { ...g, auth: createMerchantAuth({ pool, env: { ...g.env, MERCHANT_GITHUB_IDS: '12345678' } }) };
  try {
    const response = await finishGoogle(revoked, attempt);
    assert.match(response.headers.get('location'), /error=/);
    assert.equal((await pool.query('SELECT count(*)::int count FROM merchant_accounts WHERE "providerId"=$1 AND "accountId"=$2', ['google', fixture.sub])).rows[0].count, 0);
  } finally { fixture.provider.mock.restore(); }
  const { sub } = await linkGoogle(g);
  const login = await beginGoogle(revoked, { link: false });
  const provider = mockGoogle(login, { sub });
  try { assert.match((await finishGoogle(revoked, login)).headers.get('location'), /error=/); }
  finally { provider.provider.mock.restore(); }
});

test('a Google identity already linked to another merchant cannot be reassigned', async () => {
  const first = await googleFixture();
  const second = await googleFixture();
  const { sub } = await linkGoogle(first);
  const attempt = await beginGoogle(second);
  const fixture = mockGoogle(attempt, { sub });
  try {
    const response = await finishGoogle(second, attempt);
    assert.match(response.headers.get('location'), /error=/);
    assert.equal((await pool.query('SELECT "userId" FROM merchant_accounts WHERE "providerId"=$1 AND "accountId"=$2', ['google', sub])).rows[0].userId, first.merchant.userId);
  } finally { fixture.provider.mock.restore(); }
});

test('Google linking verifies ID token signature, issuer, audience, nonce and verified email before persistence', async () => {
  const g = await googleFixture();
  for (const invalid of [{ badSignature: true }, { claims: { iss: 'https://attacker.example' } }, { claims: { aud: 'another-client' } }, { claims: { nonce: 'wrong-nonce' } }, { verified: false }]) {
    const attempt = await beginGoogle(g);
    const fixture = mockGoogle(attempt, invalid);
    try {
      const response = await finishGoogle(g, attempt);
      assert.match(response.headers.get('location'), /error=/);
      assert.equal((await pool.query('SELECT count(*)::int count FROM merchant_accounts WHERE "providerId"=$1 AND "accountId"=$2', ['google', fixture.sub])).rows[0].count, 0);
    } finally { fixture.provider.mock.restore(); }
  }
});

test('Google linking OAuth state requires its signed cookie and cannot be replayed', async () => {
  const g = await googleFixture();
  const { attempt } = await linkGoogle(g);
  const replay = await finishGoogle(g, attempt);
  assert.match(replay.headers.get('location'), /error=state_mismatch|error=state_invalid|error=invalid_state/);
  const missing = await beginGoogle(g);
  assert.match((await finishGoogle(g, { ...missing, cookies: '' })).headers.get('location'), /error=/);
});


test('simultaneous explicit Google callbacks bind one identity and preserve the same merchant', async () => {
  const g = await googleFixture();
  const attempts = await Promise.all([beginGoogle(g), beginGoogle(g)]);
  const tokens = attempts.map((attempt) => signedGoogleToken(attempt));
  const provider = mock.method(globalThis, 'fetch', async (input, options) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json({ keys: [googleJwk] });
    if (url === 'https://oauth2.googleapis.com/token') {
      const index = new URLSearchParams(options?.body).get('code') === 'concurrent-first' ? 0 : 1;
      return Response.json({ access_token: 'fixture-google-access-token', id_token: tokens[index].idToken, token_type: 'Bearer', expires_in: 300, scope: 'openid email profile' });
    }
    throw new Error(`Unexpected provider request: ${new URL(url).origin}`);
  });
  // Force both callbacks to observe no Google binding before either inserts.
  // This demonstrates the database invariant rather than relying on scheduling.
  const query = pool.query.bind(pool);
  let arrivals = 0;
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const deadline = setTimeout(release, 2000);
  const errorLogs = mock.method(console, 'error', () => {});
  const queries = mock.method(pool, 'query', async (sql, values, ...rest) => {
    const result = await query(sql, values, ...rest);
    if (sql === 'SELECT "accountId" FROM merchant_accounts WHERE "userId" = $1 AND "providerId" = $2'
      && values[0] === g.merchant.userId && values[1] === 'google') {
      arrivals += 1;
      if (arrivals === 2) release();
      await barrier;
    }
    return result;
  });
  try {
    const responses = await Promise.all(attempts.map((attempt, index) => finishGoogle(g, attempt, attempt.cookie, index === 0 ? 'concurrent-first' : 'concurrent-second')));
    assert.equal(arrivals, 2);
    assert.equal(responses.filter((response) => response.status === 302 && response.headers.get('location') === '/admin/orders').length, 1);
    assert.equal(responses.filter((response) => response.status === 302 && response.headers.get('location') === '/admin/sign-in?error=merchant_google_already_linked').length, 1);
    assert.equal(errorLogs.mock.callCount(), 0, 'Database identities and errors must not enter auth logs');
    const bound = (await query('SELECT "accountId", "userId" FROM merchant_accounts WHERE "userId" = $1 AND "providerId" = $2', [g.merchant.userId, 'google'])).rows;
    assert.equal(bound.length, 1);
    assert.equal(bound[0].userId, g.merchant.userId);
    assert.ok(tokens.some((token) => token.sub === bound[0].accountId));
    assert.deepEqual(await g.auth.authorize(asRequest(g.merchant.cookie)), { userId: g.merchant.userId, role: 'merchant' });
    assert.equal((await query('SELECT count(*)::int count FROM merchant_users WHERE id = $1', [g.merchant.userId])).rows[0].count, 1);
  } finally {
    clearTimeout(deadline);
    release();
    queries.mock.restore();
    errorLogs.mock.restore();
    provider.mock.restore();
  }
});
