import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import pg from 'pg';
import { createHandler } from '../src/api.js';
import { ApiError } from '../src/errors.js';
import { databaseConfig } from '../src/database.js';
import { migrate } from '../src/migrate.js';
import { cleanupExpired } from '../src/cleanup.js';
import { MerchantOrders, merchantQuery } from '../src/merchant-orders.js';
import { OrderService } from '../src/service.js';

const schema = `test_${randomUUID().replaceAll('-', '')}`;
const now = new Date('2026-11-01T16:00:00.000Z');
const secret = 'test-orders-secret-0123456789-abcdef';
let admin;
let pool;
let merchant;
let service;
let server;
let base;
const logs = [];
const denied = (code) => (error) => error.code === code;
const params = (query = '') => new URLSearchParams(query);

before(async () => {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL is required; integration tests are never skipped.');
  const url = new URL(process.env.DATABASE_URL);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Tests require an isolated loopback PostgreSQL database.');
  const config = databaseConfig({ DATABASE_URL: process.env.DATABASE_URL });
  admin = new pg.Pool(config);
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({ ...config, options: `-c search_path=${schema}`, max: 12 });
  await migrate(pool);
  merchant = new MerchantOrders(pool, { now: () => now });
  service = new OrderService(pool, { now: () => now });
  server = createServer(createHandler({ service, merchantOrders: merchant,
    authorizeMerchant: async (request) => {
      if (request.headers.authorization === 'Bearer fixture-merchant') return { userId: 'merchant-fixture', role: 'merchant' };
      if (request.headers.authorization === 'Bearer fixture-ordinary-user') throw new ApiError(403, 'MERCHANT_FORBIDDEN', 'Merchant access is required.');
      throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in to view merchant orders.');
    }, secret, logger: (line) => logs.push(JSON.parse(line)) }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(async () => { await pool.query('TRUNCATE checkout_quotes CASCADE'); logs.length = 0; });

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
});

async function seed({ index = 1, payment = 'SIMULATED', created = now.toISOString(), expires = '2026-12-01T16:00:00.000Z', extra = {} } = {}) {
  const guest = randomUUID();
  const quote = await service.createQuote(guest, { items: [{ productId: 'demo-notebook', quantity: 2 }], shippingMethod: 'demo-standard', destination: { country: 'US', region: 'CA' } });
  const id = `order_00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
  const provider = payment === 'SIMULATED' ? 'simulated' : 'stripe-test';
  const receipt = { ...quote, id, quoteId: quote.id, reference: `${provider === 'simulated' ? 'DEMO' : 'TEST'}-${id.slice(6).toUpperCase()}`,
    createdAt: new Date(created).toISOString(), expiresAt: expires, status: { SIMULATED: 'CONFIRMED', PAID: 'CONFIRMED', PENDING: 'PENDING_PAYMENT', CANCELED: 'CANCELED', REQUIRES_REVIEW: 'PAYMENT_REVIEW' }[payment],
    paymentStatus: payment, paymentProvider: provider, ...(provider === 'stripe-test' ? { paymentMode: 'test' } : {}), ...extra };
  await pool.query('UPDATE checkout_quotes SET payment_provider = $2 WHERE id = $1', [quote.id, provider]);
  await pool.query('INSERT INTO orders (id, quote_id, guest_id, receipt, created_at, expires_at, payment_provider) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, quote.id, guest, receipt, created, expires, provider]);
  return { id, guest, receipt };
}

async function http(path, { authorization = 'Bearer fixture-merchant', method = 'GET', headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, { method, headers: { authorization, ...headers } });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

test('merchant filters are strict, bounded and reject duplicate or unknown query inputs', async () => {
  assert.deepEqual(merchantQuery(), { status: 'all', limit: 20, cursor: null });
  for (const candidate of ['status=', 'status=unknown', 'status=paid&status=pending', 'limit=0', 'limit=51', 'limit=1.5', 'limit=01', 'limit=1&limit=2', 'search=secret', 'cursor=', 'cursor=not-json', 'cursor=' + 'A'.repeat(513)]) {
    await assert.rejects(merchant.list(params(candidate)), denied('INVALID_MERCHANT_QUERY'));
  }
  assert.equal(merchantQuery(params('limit=50')).limit, 50);
});

test('an empty merchant inbox returns an explicit terminal page', async () => {
  assert.deepEqual(await merchant.list(params()), { orders: [], pageInfo: { nextCursor: null, hasMore: false } });
});

test('newest-first keyset pagination is deterministic for equal timestamps and concurrent newer inserts', async () => {
  for (const index of [1, 2, 3, 4, 5]) await seed({ index });
  const first = await merchant.list(params('limit=2'));
  assert.deepEqual(first.orders.map((o) => o.id.slice(-1)), ['5', '4']);
  assert.equal(first.pageInfo.hasMore, true);
  await seed({ index: 6, created: '2026-11-01T16:01:00.000Z' });
  const second = await merchant.list(params(`limit=2&cursor=${first.pageInfo.nextCursor}`));
  const third = await merchant.list(params(`limit=2&cursor=${second.pageInfo.nextCursor}`));
  assert.deepEqual([...second.orders, ...third.orders].map((o) => o.id.slice(-1)), ['3', '2', '1']);
  assert.deepEqual(third.pageInfo, { nextCursor: null, hasMore: false });
  assert.equal((await merchant.list(params('limit=2'))).orders[0].id.slice(-1), '6');
});

test('pagination preserves database microseconds rather than skipping sub-millisecond orders', async () => {
  await seed({ index: 1, created: '2026-11-01T16:00:00.000001Z' });
  await seed({ index: 2, created: '2026-11-01T16:00:00.000002Z' });
  await seed({ index: 3, created: '2026-11-01T16:00:00.000003Z' });
  let page = await merchant.list(params('limit=1'));
  const ids = [page.orders[0].id];
  while (page.pageInfo.hasMore) { page = await merchant.list(params(`limit=1&cursor=${page.pageInfo.nextCursor}`)); ids.push(page.orders[0].id); }
  assert.deepEqual(ids.map((id) => id.slice(-1)), ['3', '2', '1']);
});

test('payment filters distinguish verified Stripe payments from simulated confirmations', async () => {
  const states = ['PAID', 'PENDING', 'CANCELED', 'REQUIRES_REVIEW', 'SIMULATED'];
  for (let index = 0; index < states.length; index++) await seed({ index: index + 1, payment: states[index] });
  for (const [index, filter] of ['paid', 'pending', 'canceled', 'review', 'simulated'].entries()) {
    const result = await merchant.list(params(`status=${filter}`));
    assert.equal(result.orders.length, 1);
    assert.equal(result.orders[0].paymentStatus, states[index]);
    assert.equal(result.orders[0].itemCount, 2);
    assert.equal(result.orders[0].paymentProvider, filter === 'simulated' ? 'simulated' : 'stripe-test');
  }
});

test('cursor cannot be reused with another filter and malformed envelopes are rejected', async () => {
  await seed({ index: 1, payment: 'PAID' }); await seed({ index: 2, payment: 'PAID' });
  const first = await merchant.list(params('status=paid&limit=1'));
  await assert.rejects(merchant.list(params(`status=simulated&cursor=${first.pageInfo.nextCursor}`)), denied('INVALID_MERCHANT_QUERY'));
  const decoded = JSON.parse(Buffer.from(first.pageInfo.nextCursor, 'base64url'));
  for (const data of [{ ...decoded, v: 2 }, { ...decoded, secret: 'unexpected' }, { ...decoded, at: '2026-02-30T16:00:00.000000Z' }, { ...decoded, at: '0000-01-01T00:00:00.000000Z' }, { ...decoded, id: "';DROP TABLE orders;--" }, null, []]) {
    const cursor = Buffer.from(JSON.stringify(data)).toString('base64url');
    await assert.rejects(merchant.list(params(`status=paid&cursor=${cursor}`)), denied('INVALID_MERCHANT_QUERY'));
  }
});

test('resolved expired orders are hidden while unresolved Stripe orders remain available for review', async () => {
  const expires = '2026-10-01T16:00:00.000Z';
  for (const [index, payment] of ['SIMULATED', 'PAID', 'CANCELED', 'PENDING', 'REQUIRES_REVIEW'].entries()) await seed({ index: index + 1, payment, expires });
  const result = await merchant.list(params());
  assert.deepEqual(result.orders.map((o) => o.paymentStatus), ['REQUIRES_REVIEW', 'PENDING']);
  for (const index of [1, 2, 3]) await assert.rejects(merchant.read(`order_00000000-0000-4000-8000-${String(index).padStart(12, '0')}`), denied('ORDER_NOT_FOUND'));
  for (const order of result.orders) assert.equal((await merchant.read(order.id)).paymentStatus, order.paymentStatus);
});

test('merchant DTOs project known fields and normalize historical simulated receipts', async () => {
  const { id, guest } = await seed({ extra: { paymentProvider: undefined, guestId: 'must-not-leak', checkoutUrl: 'must-not-leak', stripeSessionId: 'must-not-leak', secret: 'must-not-leak' } });
  await pool.query("UPDATE orders SET receipt = jsonb_set(receipt, '{items,0,internal}', '\"must-not-leak\"'::jsonb) WHERE id = $1", [id]);
  const list = await merchant.list(params());
  const detail = await merchant.read(id);
  assert.equal(list.orders[0].paymentProvider, 'simulated');
  assert.equal(detail.paymentProvider, 'simulated');
  assert.equal(detail.items[0].name, 'Notebook');
  assert.equal(list.orders[0].itemCount, 2);
  const serialized = JSON.stringify({ list, detail });
  for (const value of [guest, 'must-not-leak', 'guestId', 'checkoutUrl', 'stripeSessionId', 'internal']) assert.equal(serialized.includes(value), false);
  assert.deepEqual(Object.keys(list.orders[0]).sort(), ['id', 'reference', 'createdAt', 'status', 'paymentStatus', 'paymentProvider', 'totalCents', 'currency', 'itemCount'].sort());
  assert.equal(Object.hasOwn(detail, 'paymentMode'), false);
});

test('a checkout-created order is visible to merchants but another guest still cannot read it', async () => {
  const guest = randomUUID();
  const quote = await service.createQuote(guest, { items: [{ productId: 'demo-notebook', quantity: 1 }], shippingMethod: 'demo-standard', destination: { country: 'US', region: 'CA' } });
  const { order } = await service.createOrder(guest, { quoteId: quote.id }, randomUUID());
  assert.equal((await merchant.list(params())).orders[0].id, order.id);
  assert.equal((await merchant.read(order.id)).totalCents, 1836);
  await assert.rejects(service.readOrder(randomUUID(), order.id), denied('ORDER_NOT_FOUND'));
});

test('merchant HTTP reads require merchant authorization; guest bearer and spoofed identity headers cannot grant access', async () => {
  const { id } = await seed();
  for (const path of ['/v1/merchant/session', '/v1/merchant/orders', `/v1/merchant/orders/${id}`]) {
    for (const authorization of ['', `Bearer ${secret}`, 'Bearer invalid']) {
      const result = await http(path, { authorization, headers: { 'x-guest-id': randomUUID(), 'x-user-id': 'merchant-fixture', 'x-merchant-role': 'admin' } });
      assert.equal(result.status, 401);
      assert.equal(result.body.error.code, 'AUTH_REQUIRED');
      assert.equal(result.headers.get('cache-control'), 'private, no-store');
    }
    assert.equal((await http(path, { authorization: 'Bearer fixture-ordinary-user' })).status, 403);
    const result = await http(path);
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('cache-control'), 'private, no-store');
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal((await http(`/v1/merchant/orders/${id}`, { method })).status, 405);
  assert.equal((await http('/v1/merchant/orders?limit=51')).status, 400);
  assert.equal((await http(`/v1/merchant/orders/${id}?unexpected=1`)).status, 400);
  assert.equal((await http('/v1/merchant/orders/not-an-id')).status, 404);
  const serialized = JSON.stringify(logs);
  assert.equal(serialized.includes(id), false);
  assert.equal(serialized.includes('fixture-merchant'), false);
});

test('missing merchant auth configuration fails closed without breaking guest checkout', async () => {
  const disabled = createServer(createHandler({ service, secret, merchantOrders: merchant, logger: () => {} }));
  await new Promise((resolve) => disabled.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${disabled.address().port}/v1/merchant/orders`, { headers: { authorization: `Bearer ${secret}` } });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'MERCHANT_UNAVAILABLE');
    const health = await fetch(`http://127.0.0.1:${disabled.address().port}/health`);
    assert.equal(health.status, 200);
  } finally { await new Promise((resolve) => disabled.close(resolve)); }
});

test('merchant session response contains only the authorized user id and merchant role', async () => {
  const result = await http('/v1/merchant/session');
  assert.deepEqual(result.body, { user: { id: 'merchant-fixture' }, role: 'merchant' });
  assert.equal((await http('/v1/merchant/session?debug=1')).status, 400);
});

test('authentication bridge bounds input, fixes callback destinations and preserves all cookies', async () => {
  const calls = [];
  const authOrigin = 'https://joys-store.vercel.app';
  const temporary = createServer(createHandler({ service, secret, logger: () => {}, merchantAuth: () => ({ origin: authOrigin, handler: async (request) => {
    calls.push({ url: request.url, headers: request.headers, body: request.method === 'POST' ? await request.json() : null });
    const headers = new Headers({ 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' });
    headers.append('set-cookie', '__Secure-joys_merchant.session_token=fixture; Path=/; HttpOnly; Secure; SameSite=Lax');
    headers.append('set-cookie', '__Secure-joys_merchant.state=fixture-state; Path=/; HttpOnly; Secure; SameSite=Lax');
    return new Response(JSON.stringify({ ok: true }), { headers });
  } }) }));
  await new Promise((resolve) => temporary.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${temporary.address().port}`;
  const social = { provider: 'github', callbackURL: '/admin/orders', errorCallbackURL: '/admin/sign-in' };
  const post = (path, input, headers = {}) => fetch(`${origin}${path}`, { method: 'POST', headers: { origin: authOrigin, 'content-type': 'application/json', ...headers }, body: typeof input === 'string' ? input : JSON.stringify(input) });
  try {
    const success = await post('/api/auth/sign-in/social', social, { authorization: `Bearer ${secret}`, 'x-forwarded-host': 'attacker.example', 'x-guest-id': randomUUID() });
    assert.equal(success.status, 200);
    assert.equal(success.headers.getSetCookie().length, 2);
    assert.equal(success.headers.get('cache-control'), 'private, no-store');
    assert.equal(calls[0].url, `${authOrigin}/api/auth/sign-in/social`);
    for (const name of ['authorization', 'x-forwarded-host', 'x-guest-id']) assert.equal(calls[0].headers.has(name), false);
    assert.equal((await post('/api/auth/sign-in/social', social, { origin: 'https://attacker.example' })).status, 403);
    assert.equal((await post('/api/auth/sign-in/social', { ...social, callbackURL: 'https://attacker.example' })).status, 400);
    assert.equal((await post('/api/auth/sign-in/social', { ...social, provider: 'google' })).status, 400);
    assert.equal((await post('/api/auth/sign-in/social', { ...social, extra: true })).status, 400);
    assert.equal((await post('/api/auth/sign-out', { extra: true })).status, 400);
    assert.equal((await post('/api/auth/sign-out', 'x'.repeat(16385))).status, 413);
    assert.equal((await post('/api/auth/sign-up/email', {})).status, 404);
    assert.equal((await fetch(`${origin}/api/auth/get-session`)).status, 404);
    assert.equal((await fetch(`${origin}/api/auth/sign-in/social`)).status, 405);
    assert.equal((await post('/api/auth/sign-out', {})).status, 200);
    const callback = await fetch(`${origin}/api/auth/callback/github?code=fixture-code&state=fixture-state`);
    assert.equal(callback.status, 200);
    assert.equal(calls.at(-1).url, `${authOrigin}/api/auth/callback/github?code=fixture-code&state=fixture-state`);
    assert.equal((await fetch(`${origin}/api/auth/ok`)).status, 200);
  } finally { await new Promise((resolve) => temporary.close(resolve)); }
});

test('daily cleanup expires authentication state without removing merchant identities or active sessions', async () => {
  const user = `user-${randomUUID()}`;
  await pool.query('INSERT INTO merchant_users (id, name, email, "emailVerified") VALUES ($1,$2,$3,true)', [user, 'Merchant fixture', `${user}@example.test`]);
  await pool.query('INSERT INTO merchant_accounts (id,"accountId","providerId","userId","updatedAt") VALUES ($1,$2,$3,$4,$5)', [randomUUID(), randomUUID(), 'github', user, now]);
  for (const offset of [-1, 1]) {
    const expires = new Date(now.getTime() + offset * 86400000);
    await pool.query('INSERT INTO merchant_sessions (id, token, "expiresAt", "updatedAt", "userId") VALUES ($1,$2,$3,$4,$5)', [randomUUID(), randomUUID(), expires, now, user]);
    await pool.query('INSERT INTO merchant_verifications (id, identifier, value, "expiresAt") VALUES ($1,$2,$3,$4)', [randomUUID(), randomUUID(), 'fixture-state', expires]);
    await pool.query('INSERT INTO merchant_rate_limits (id, key, count, "lastRequest") VALUES ($1,$2,1,$3)', [randomUUID(), randomUUID(), now.getTime() + offset * 86400000]);
  }
  const result = await cleanupExpired(pool, now);
  assert.equal(result.merchantSessions, 1);
  assert.equal(result.merchantVerifications, 1);
  assert.equal(result.merchantRateLimits, 1);
  for (const table of ['merchant_users', 'merchant_accounts', 'merchant_sessions', 'merchant_verifications', 'merchant_rate_limits']) assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count, 1);
  const repeated = await cleanupExpired(pool, now);
  assert.equal(repeated.merchantSessions + repeated.merchantVerifications + repeated.merchantRateLimits, 0);
});
