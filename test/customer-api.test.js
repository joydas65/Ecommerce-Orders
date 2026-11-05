import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { createHandler } from '../src/api.js';
import { databaseConfig } from '../src/database.js';
import { migrate } from '../src/migrate.js';
import { OrderService } from '../src/service.js';
import { CustomerOrders } from '../src/customer-orders.js';
import { MerchantOrders } from '../src/merchant-orders.js';
import { createCustomerAuth } from '../src/customer-auth.js';
import { createMerchantAuth } from '../src/merchant-auth.js';
import { cleanupExpired } from '../src/cleanup.js';
import { seedCustomerSessions } from '../scripts/test/seed-customer-session.mjs';
import { seedMerchantSessions } from '../scripts/test/seed-merchant-session.mjs';

const schema = `customer_api_${randomUUID().replaceAll('-', '')}`;
const secret = 'fixture-service-secret-at-least-32-characters';
const env = { CUSTOMER_AUTH_ENABLED: 'true', CUSTOMER_ALLOW_LOCAL_AUTH: 'true', CUSTOMER_TEST_FIXTURES: 'true',
  CUSTOMER_AUTH_URL: 'http://127.0.0.1:3100', CUSTOMER_AUTH_SECRET: randomBytes(32).toString('hex'),
  GOOGLE_CLIENT_ID: 'fixture-google.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'fixture-google-secret-at-least-20',
  MERCHANT_AUTH_ENABLED: 'true', MERCHANT_ALLOW_LOCAL_AUTH: 'true', MERCHANT_TEST_FIXTURES: 'true',
  BETTER_AUTH_URL: 'http://127.0.0.1:3100', BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
  GITHUB_CLIENT_ID: 'fixture-github', GITHUB_CLIENT_SECRET: 'fixture-github-secret-at-least-20', MERCHANT_GITHUB_IDS: '123456789',
  MERCHANT_GOOGLE_ENABLED: 'true' };
const input = { items: [{ productId: 'demo-notebook', quantity: 1 }], shippingMethod: 'demo-standard', destination: { country: 'US', region: 'CA' } };
const signIn = { provider: 'google', callbackURL: '/account', errorCallbackURL: '/account/sign-in' };
const logs = [], servers = [];
let admin, pool, service, auth, merchant, fixtures, merchantFixtures, base;
before(async () => {
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.DATABASE_URL || 'invalid:').hostname), 'Customer API tests require disposable loopback PostgreSQL.');
  env.DATABASE_URL = process.env.DATABASE_URL;
  const config = databaseConfig({ DATABASE_URL: env.DATABASE_URL });
  admin = new pg.Pool(config);
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({ ...config, options: `-c search_path=${schema}` });
  await migrate(pool);
  service = new OrderService(pool);
  auth = createCustomerAuth({ pool, env }); merchant = createMerchantAuth({ pool, env });
  fixtures = await seedCustomerSessions({ pool, env }); merchantFixtures = await seedMerchantSessions({ pool, env });
  base = await start({ customerAuth: () => auth, authorizeCustomer: (request) => auth.authorize(request), customerOrders: new CustomerOrders(pool),
    merchantAuth: () => merchant, authorizeMerchant: (request) => merchant.authorize(request), merchantOrders: new MerchantOrders(pool) });
});
after(async () => {
  for (const server of servers) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
});
async function start(options) {
  const server = createServer(createHandler({ service, secret, logger: (line) => logs.push(JSON.parse(line)), ...options }));
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function http(path, { target = base, method = 'GET', cookie, body, headers = {}, guest, key, bearer = false } = {}) {
  const response = await fetch(`${target}${path}`, { method, redirect: 'manual', headers: {
    ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    ...(guest ? { 'x-guest-id': guest } : {}), ...(key ? { 'idempotency-key': key } : {}), ...(bearer ? { authorization: `Bearer ${secret}` } : {}), ...headers,
  }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
  const text = await response.text(); let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, headers: response.headers, data };
}
async function quote() { const guest = randomUUID(); return { guest, value: await service.createQuote(guest, input), key: randomUUID() }; }

test('customer OAuth exposes only the intended redirect flow, fixed provider and callback', async () => {
  const response = await http('/api/customer-auth/sign-in/social', { method: 'POST', body: signIn, headers: { origin: auth.origin } });
  assert.equal(response.status, 200);
  assert.equal(new URL(response.data.url).origin, 'https://accounts.google.com');
  assert.equal(new URL(response.data.url).searchParams.get('redirect_uri'), `${auth.origin}/api/customer-auth/callback/google`);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  for (const endpoint of ['sign-up/email', 'sign-in/email', 'link-social', 'get-session', 'callback/github', 'admin/list-users', 'token']) {
    assert.equal((await http(`/api/customer-auth/${endpoint}`, { method: endpoint.startsWith('callback/') ? 'GET' : 'POST', body: endpoint.startsWith('callback/') ? undefined : {}, headers: { origin: auth.origin } })).status, 404);
  }
  assert.equal((await http('/api/customer-auth/sign-in/social')).status, 405);
  for (const body of [ { ...signIn, provider: 'github' }, { ...signIn, callbackURL: '/admin/orders' }, { ...signIn, callbackURL: 'https://attacker.example' },
    { ...signIn, errorCallbackURL: '/admin/sign-in' }, { ...signIn, idToken: { token: 'untrusted' } }, { ...signIn, scopes: ['gmail'] }, [], null ]) {
    assert.equal((await http('/api/customer-auth/sign-in/social', { method: 'POST', body, headers: { origin: auth.origin } })).status, 400);
  }
  assert.equal((await http('/api/customer-auth/ok?extra=1')).status, 400);
  assert.equal((await http('/api/customer-auth/sign-in/social', { method: 'POST', body: signIn, headers: { origin: auth.origin, 'content-type': 'text/plain' } })).status, 415);
});

test('customer and merchant auth reject cross-site and same-site requests before provider calls', async () => {
  for (const [prefix, data] of [['/api/customer-auth', signIn], ['/api/auth', { provider: 'github', callbackURL: '/admin/orders', errorCallbackURL: '/admin/sign-in' }]]) {
    for (const headers of [{ origin: 'https://attacker.example' }, { origin: auth.origin, 'sec-fetch-site': 'cross-site' }, { origin: auth.origin, 'sec-fetch-site': 'same-site' }, {}]) {
      const response = await http(`${prefix}/sign-in/social`, { method: 'POST', body: data, headers });
      assert.equal(response.status, 403);
    }
  }
  const customerLink = await http('/api/auth/link-social', { method: 'POST', cookie: fixtures.customer.cookie, headers: { origin: merchant.origin },
    body: { provider: 'google', callbackURL: '/admin/orders', errorCallbackURL: '/admin/sign-in' } });
  assert.equal(customerLink.status, 401);
});

test('account session APIs require customer cookies and never accept merchant, bearer or guest authority', async () => {
  const session = await http('/v1/customer/session', { cookie: fixtures.customer.cookie });
  assert.equal(session.status, 200);
  assert.deepEqual(session.data, { user: { id: fixtures.customer.userId, displayName: 'Local customer' }, role: 'customer' });
  assert.equal(session.headers.get('cache-control'), 'private, no-store');
  for (const options of [{}, { bearer: true }, { guest: randomUUID() }, { headers: { 'x-customer-id': fixtures.customer.userId, 'x-role': 'customer' } }, { cookie: merchantFixtures.merchant.cookie }]) {
    assert.equal((await http('/v1/customer/session', options)).status, 401);
    assert.equal((await http('/v1/customer/orders', options)).status, 401);
  }
  assert.equal((await http('/v1/merchant/session', { cookie: fixtures.customer.cookie })).status, 401);
  assert.equal((await http('/v1/customer/session?extra=1', { cookie: fixtures.customer.cookie })).status, 400);
  assert.equal((await http('/v1/customer/orders', { method: 'POST', cookie: fixtures.customer.cookie, body: {} })).status, 405);
});

test('checkout derives account ownership only from a verified session and still requires service authorization', async () => {
  const q = await quote();
  assert.equal((await http('/v1/orders', { method: 'POST', cookie: fixtures.customer.cookie, guest: q.guest, key: q.key, body: { quoteId: q.value.id } })).status, 401);
  const placed = await http('/v1/orders', { method: 'POST', bearer: true, cookie: fixtures.customer.cookie, guest: q.guest, key: q.key, body: { quoteId: q.value.id }, headers: { 'x-customer-id': fixtures.other.userId } });
  assert.equal(placed.status, 201);
  assert.equal((await pool.query('SELECT customer_user_id FROM orders WHERE id = $1', [placed.data.id])).rows[0].customer_user_id, fixtures.customer.userId);
  const receipt = await http(`/v1/customer/orders/${placed.data.id}`, { cookie: fixtures.customer.cookie });
  assert.equal(receipt.status, 200); assert.equal(receipt.data.id, placed.data.id);
  assert.equal((await http(`/v1/customer/orders/${placed.data.id}`, { cookie: fixtures.other.cookie })).status, 404);
  assert.equal((await http(`/v1/customer/orders/${placed.data.id}`, { bearer: true, guest: q.guest })).status, 401);
  const ownList = await http('/v1/customer/orders?limit=20', { cookie: fixtures.customer.cookie });
  assert.ok(ownList.data.orders.some((order) => order.id === placed.data.id));
  assert.equal((await http('/v1/customer/orders', { cookie: fixtures.other.cookie })).data.orders.length, 0);
  const replay = await http('/v1/orders', { method: 'POST', bearer: true, cookie: fixtures.customer.cookie, guest: q.guest, key: q.key, body: { quoteId: q.value.id } });
  assert.equal(replay.status, 200); assert.equal(replay.data.id, placed.data.id);
  const switched = await http('/v1/orders', { method: 'POST', bearer: true, cookie: fixtures.other.cookie, guest: q.guest, key: q.key, body: { quoteId: q.value.id } });
  assert.equal(switched.status, 409); assert.equal(switched.data.error.code, 'CUSTOMER_CHECKOUT_CHANGED');
});

test('expired or malformed account sessions cannot silently submit a guest order', async () => {
  for (const cookie of [fixtures.expiredCookie, 'joys_customer.session_token=malformed']) {
    const q = await quote();
    const response = await http('/v1/orders', { method: 'POST', bearer: true, cookie, guest: q.guest, key: q.key, body: { quoteId: q.value.id } });
    assert.equal(response.status, 401);
    assert.equal((await pool.query('SELECT count(*)::int count FROM orders WHERE quote_id = $1', [q.value.id])).rows[0].count, 0);
  }
});

test('guest checkout ignores submitted ownership headers and rejects ownership in request bodies', async () => {
  const q = await quote();
  const tampered = await http('/v1/orders', { method: 'POST', bearer: true, guest: q.guest, key: q.key, body: { quoteId: q.value.id, customerId: fixtures.customer.userId } });
  assert.equal(tampered.status, 400);
  const guest = await http('/v1/orders', { method: 'POST', bearer: true, guest: q.guest, key: q.key, body: { quoteId: q.value.id }, headers: { 'x-customer-id': fixtures.customer.userId } });
  assert.equal(guest.status, 201);
  assert.equal((await pool.query('SELECT customer_user_id FROM orders WHERE id = $1', [guest.data.id])).rows[0].customer_user_id, null);
  assert.equal((await http(`/v1/customer/orders/${guest.data.id}`, { cookie: fixtures.customer.cookie })).status, 404);
  assert.equal((await http(`/v1/orders/${guest.data.id}`, { bearer: true, guest: q.guest })).status, 200);
});

test('disabled customer authentication fails closed while anonymous order creation remains available', async () => {
  const target = await start({});
  assert.equal((await http('/v1/customer/session', { target, cookie: fixtures.customer.cookie })).status, 503);
  assert.equal((await http('/api/customer-auth/ok', { target })).status, 503);
  const q = await quote();
  const failed = await http('/v1/orders', { target, method: 'POST', bearer: true, cookie: fixtures.customer.cookie, guest: q.guest, key: q.key, body: { quoteId: q.value.id } });
  assert.equal(failed.status, 503);
  const guest = await http('/v1/orders', { target, method: 'POST', bearer: true, guest: q.guest, key: q.key, body: { quoteId: q.value.id } });
  assert.equal(guest.status, 201);
});

test('sign-out through the HTTP boundary revokes only the customer session', async () => {
  const response = await http('/api/customer-auth/sign-out', { method: 'POST', cookie: fixtures.other.cookie, body: {}, headers: { origin: auth.origin } });
  assert.equal(response.status, 200);
  assert.equal((await http('/v1/customer/session', { cookie: fixtures.other.cookie })).status, 401);
  assert.equal((await http('/v1/customer/session', { cookie: fixtures.customer.cookie })).status, 200);
  assert.equal((await http('/v1/merchant/session', { cookie: merchantFixtures.merchant.cookie })).status, 200);
});

test('retention cleanup expires customer auth state but keeps stable identities and retained order ownership', async () => {
  const now = new Date();
  await pool.query('INSERT INTO customer_sessions (id, token, \"userId\", \"expiresAt\", \"updatedAt\") VALUES ($1, $2, $3, $4, now())', [randomUUID(), randomUUID(), fixtures.customer.userId, new Date(now.getTime() - 60000)]);
  for (const [suffix, expiry] of [['expired', new Date(now.getTime() - 60000)], ['live', new Date(now.getTime() + 60000)]]) {
    await pool.query('INSERT INTO customer_verifications (id, identifier, value, "expiresAt") VALUES ($1, $2, $3, $4)', [`verification-${suffix}`, suffix, 'fixture', expiry]);
    await pool.query('INSERT INTO customer_rate_limits (id, key, count, "lastRequest") VALUES ($1, $2, 1, $3)', [`rate-${suffix}`, `rate-${suffix}`, now.getTime() - (suffix === 'expired' ? 86400001 : 1000)]);
  }
  const usersBefore = (await pool.query('SELECT count(*)::int count FROM customer_users')).rows[0].count;
  const ownedBefore = (await pool.query('SELECT count(*)::int count FROM orders WHERE customer_user_id = $1', [fixtures.customer.userId])).rows[0].count;
  const counts = await cleanupExpired(pool, now);
  assert.equal(counts.customerSessions, 1); assert.equal(counts.customerVerifications, 1); assert.equal(counts.customerRateLimits, 1);
  assert.equal((await pool.query('SELECT count(*)::int count FROM customer_users')).rows[0].count, usersBefore);
  assert.equal((await pool.query('SELECT count(*)::int count FROM orders WHERE customer_user_id = $1', [fixtures.customer.userId])).rows[0].count, ownedBefore);
  assert.equal((await http('/v1/customer/session', { cookie: fixtures.customer.cookie })).status, 200);
  assert.equal((await pool.query('SELECT count(*)::int count FROM customer_verifications WHERE id = $1', ['verification-live'])).rows[0].count, 1);
  const repeated = await cleanupExpired(pool, now);
  assert.equal(repeated.customerSessions + repeated.customerVerifications + repeated.customerRateLimits, 0);
  for (const value of [fixtures.customer.userId, fixtures.customer.cookie, secret, env.CUSTOMER_AUTH_SECRET]) assert.equal(JSON.stringify(logs).includes(value), false);
});
