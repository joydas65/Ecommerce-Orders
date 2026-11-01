import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import pg from 'pg';
import { createHandler } from '../src/api.js';
import { cleanupExpired } from '../src/cleanup.js';
import { databaseConfig } from '../src/database.js';
import { migrate } from '../src/migrate.js';
import { OrderService } from '../src/service.js';

const secret = 'test-orders-secret-0123456789-abcdef';
const cronSecret = 'test-cleanup-secret-0123456789-abcdef';
const schema = `test_${randomUUID().replaceAll('-', '')}`;
let admin;
let pool;
let service;
let server;
let base;
const logs = [];
const input = (overrides = {}) => ({ items: [{ productId: 'demo-desk-mat', quantity: 1 }], shippingMethod: 'demo-standard', destination: { country: 'US', region: 'CA' }, ...overrides });
const errorCode = (code) => (error) => error.code === code;

before(async () => {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL is required; integration tests are never skipped.');
  const url = new URL(process.env.DATABASE_URL);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Tests require an isolated loopback PostgreSQL database.');
  const config = databaseConfig({ DATABASE_URL: process.env.DATABASE_URL });
  admin = new pg.Pool(config);
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({ ...config, options: `-c search_path=${schema}`, max: 12 });
  await migrate(pool);
  service = new OrderService(pool);
  server = createServer(createHandler({ service, secret, cronSecret, cleanup: () => cleanupExpired(pool), logger: (line) => logs.push(JSON.parse(line)) }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  if (admin) {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});

async function http(path, { method = 'GET', guest = randomUUID(), key, body, authorization = `Bearer ${secret}`, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, { method, headers: { authorization, 'x-guest-id': guest, ...(key ? { 'idempotency-key': key } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

test('migrations are repeatable and reject changes to an applied migration', async () => {
  await migrate(pool);
  const original = (await pool.query('SELECT checksum FROM schema_migrations')).rows[0].checksum;
  await pool.query("UPDATE schema_migrations SET checksum = 'modified'");
  await assert.rejects(migrate(pool), /applied migration was modified/);
  await pool.query('UPDATE schema_migrations SET checksum = $1', [original]);
  await migrate(pool);
});

test('quote totals are authoritative integer cents and retain no destination or personal fields', async () => {
  const guest = randomUUID();
  const quote = await service.createQuote(guest, input());
  assert.equal(quote.subtotalCents, 3400);
  assert.equal(quote.shippingCents, 500);
  assert.equal(quote.taxCents, 312);
  assert.equal(quote.totalCents, 4212);
  assert.equal(quote.currency, 'USD');
  assert.equal(quote.pricingVersion, 'demo-v1');
  assert.deepEqual(quote.items, [{ productId: 'demo-desk-mat', name: 'Desk Mat', quantity: 1, unitPriceCents: 3400, lineTotalCents: 3400 }]);
  const row = (await pool.query('SELECT snapshot, created_at, expires_at FROM checkout_quotes WHERE id = $1', [quote.id])).rows[0];
  assert.equal(row.expires_at - row.created_at, 15 * 60 * 1000);
  assert.deepEqual(row.snapshot, quote);
  assert.equal(JSON.stringify(row).includes('destination'), false);
});

test('all six catalog products and express shipping use the seeded prices', async () => {
  const quote = await service.createQuote(randomUUID(), input({ items: [
    { productId: 'demo-desk-mat', quantity: 2 }, { productId: 'demo-notebook', quantity: 3 },
    { productId: 'demo-bottle', quantity: 1 }, { productId: 'demo-tote', quantity: 1 },
    { productId: 'demo-laptop-stand', quantity: 1 }, { productId: 'demo-desk-lamp', quantity: 1 },
  ], shippingMethod: 'demo-express', destination: { country: 'SG' } }));
  assert.equal(quote.subtotalCents, 26600);
  assert.equal(quote.shippingCents, 1200);
  assert.equal(quote.taxCents, 2224);
  assert.equal(quote.totalCents, 30024);
});

test('rejects unknown products, invalid quantities, duplicate products, prices and personal fields', async () => {
  const invalidInputs = [
    ...[0, -1, 100, 1.2, '2', null, true].map((quantity) => input({ items: [{ productId: 'demo-desk-mat', quantity }] })),
    input({ items: [{ productId: 'unknown', quantity: 1 }] }),
    input({ items: [{ productId: '__proto__', quantity: 1 }] }),
    input({ items: [] }), input({ items: Array(7).fill({ productId: 'demo-desk-mat', quantity: 1 }) }),
    input({ items: [{ productId: 'demo-desk-mat', quantity: 1 }, { productId: 'demo-desk-mat', quantity: 2 }] }),
    input({ items: [{ productId: 'demo-desk-mat', quantity: 1, unitPriceCents: 1 }] }),
    input({ totalCents: 1 }), input({ email: 'must-not-be-stored@example.test' }),
    input({ destination: { country: 'US', region: 'CA', address: 'must-not-be-stored' } }),
    input({ destination: { country: 'GB', region: 'CA' } }), input({ destination: { country: 'US' } }),
    input({ destination: { country: 'IN' } }), input({ shippingMethod: 'free' }), null, [],
  ];
  for (const candidate of invalidInputs) await assert.rejects(service.createQuote(randomUUID(), candidate), errorCode('INVALID_REQUEST'));
});

test('order snapshots survive changes to caller objects and are isolated by guest', async () => {
  const guest = randomUUID();
  const quote = await service.createQuote(guest, input());
  quote.items[0].name = 'tampered';
  quote.totalCents = 1;
  const result = await service.createOrder(guest, { quoteId: quote.id }, randomUUID());
  assert.equal(result.replayed, false);
  assert.equal(result.order.totalCents, 4212);
  assert.equal(result.order.items[0].name, 'Desk Mat');
  assert.equal(result.order.status, 'CONFIRMED');
  assert.equal(result.order.paymentStatus, 'SIMULATED');
  assert.equal(new Date(result.order.expiresAt) - new Date(result.order.createdAt), 30 * 86400000);
  assert.deepEqual(await service.readOrder(guest, result.order.id), result.order);
  for (const [owner, id] of [[randomUUID(), result.order.id], [guest, `order_${randomUUID()}`], [guest, 'malformed']]) {
    await assert.rejects(service.readOrder(owner, id), (error) => error.status === 404 && error.code === 'ORDER_NOT_FOUND' && error.message === 'This receipt is unavailable.');
  }
});

test('a lost response can be replayed by a fresh service and database connection after quote expiry', async () => {
  const guest = randomUUID();
  const key = randomUUID();
  const quote = await service.createQuote(guest, input());
  const created = await service.createOrder(guest, { quoteId: quote.id }, key);
  const later = new Date(Date.now() + 20 * 60000);
  const newPool = new pg.Pool({ ...databaseConfig({ DATABASE_URL: process.env.DATABASE_URL }), options: `-c search_path=${schema}` });
  try {
    const fresh = new OrderService(newPool, { now: () => later });
    const replay = await fresh.createOrder(guest, { quoteId: quote.id }, key);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.order, created.order);
    assert.deepEqual(await fresh.readOrder(guest, created.order.id), created.order);
  } finally { await newPool.end(); }
});

test('eight concurrent retries create exactly one order and one durable replay record', async () => {
  const guest = randomUUID();
  const key = randomUUID();
  const quote = await service.createQuote(guest, input());
  const results = await Promise.all(Array.from({ length: 8 }, () => service.createOrder(guest, { quoteId: quote.id }, key)));
  assert.equal(results.filter((result) => !result.replayed).length, 1);
  assert.equal(new Set(results.map((result) => result.order.id)).size, 1);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM orders WHERE quote_id = $1', [quote.id])).rows[0].count, 1);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM order_submissions WHERE guest_id = $1', [guest])).rows[0].count, 1);
});

test('concurrent different keys cannot consume one quote twice', async () => {
  const guest = randomUUID();
  const quote = await service.createQuote(guest, input());
  const results = await Promise.allSettled(Array.from({ length: 4 }, () => service.createOrder(guest, { quoteId: quote.id }, randomUUID())));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.ok(results.filter((result) => result.status === 'rejected').every((result) => result.reason.code === 'QUOTE_CONSUMED'));
});

test('same key with a different quote conflicts, including concurrent submissions', async () => {
  const guest = randomUUID();
  const key = randomUUID();
  const quotes = await Promise.all([service.createQuote(guest, input()), service.createQuote(guest, input())]);
  const results = await Promise.allSettled(quotes.map((quote) => service.createOrder(guest, { quoteId: quote.id }, key)));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'IDEMPOTENCY_CONFLICT');
});

test('foreign and expired quotes cannot create an order', async () => {
  const guest = randomUUID();
  const quote = await service.createQuote(guest, input());
  await assert.rejects(service.createOrder(randomUUID(), { quoteId: quote.id }, randomUUID()), errorCode('QUOTE_NOT_FOUND'));
  const future = new OrderService(pool, { now: () => new Date(Date.now() + 16 * 60000) });
  await assert.rejects(future.createOrder(guest, { quoteId: quote.id }, randomUUID()), errorCode('QUOTE_EXPIRED'));
});

test('expired receipts and replay records are unavailable before asynchronous cleanup runs', async () => {
  const guest = randomUUID();
  const key = randomUUID();
  const quote = await service.createQuote(guest, input());
  const { order } = await service.createOrder(guest, { quoteId: quote.id }, key);
  const future = new OrderService(pool, { now: () => new Date(Date.now() + 31 * 86400000) });
  await assert.rejects(future.readOrder(guest, order.id), errorCode('ORDER_NOT_FOUND'));
  await assert.rejects(future.createOrder(guest, { quoteId: quote.id }, key), errorCode('SUBMISSION_EXPIRED'));
});

test('a failure writing the replay record rolls the order back and leaves the quote reusable', async () => {
  const guest = randomUUID();
  const quote = await service.createQuote(guest, input());
  const failurePool = { connect: async () => {
    const client = await pool.connect();
    return { release: (...args) => client.release(...args), query: (sql, args) => {
      if (sql.startsWith('INSERT INTO order_submissions')) throw new Error('Injected persistence failure');
      return client.query(sql, args);
    } };
  } };
  await assert.rejects(new OrderService(failurePool).createOrder(guest, { quoteId: quote.id }, randomUUID()), /Injected persistence failure/);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM orders WHERE quote_id = $1', [quote.id])).rows[0].count, 0);
  assert.equal((await service.createOrder(guest, { quoteId: quote.id }, randomUUID())).replayed, false);
});

test('database constraints independently prevent duplicate quote orders and mismatched ownership', async () => {
  const guest = randomUUID();
  const quote = await service.createQuote(guest, input());
  const { order } = await service.createOrder(guest, { quoteId: quote.id }, randomUUID());
  await assert.rejects(pool.query('INSERT INTO orders (id, quote_id, guest_id, receipt, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6)', [`order_${randomUUID()}`, quote.id, guest, order, order.expiresAt, order.createdAt]), (error) => error.code === '23505');
  const otherQuote = await service.createQuote(guest, input());
  await assert.rejects(pool.query('INSERT INTO orders (id, quote_id, guest_id, receipt, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6)', [`order_${randomUUID()}`, otherQuote.id, randomUUID(), order, order.expiresAt, order.createdAt]), (error) => error.code === '23503');
});

test('a database response lost after COMMIT is safely replayed with the original submission key', async () => {
  const guest = randomUUID();
  const key = randomUUID();
  const quote = await service.createQuote(guest, input());
  const ambiguousPool = { connect: async () => {
    const client = await pool.connect();
    return { release: (...args) => client.release(...args), query: async (sql, args) => {
      const result = await client.query(sql, args);
      if (sql === 'COMMIT') throw new Error('Injected response loss after durable commit');
      return result;
    } };
  } };
  await assert.rejects(new OrderService(ambiguousPool).createOrder(guest, { quoteId: quote.id }, key), /response loss after durable commit/);
  const retry = await service.createOrder(guest, { quoteId: quote.id }, key);
  assert.equal(retry.replayed, true);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM orders WHERE quote_id = $1', [quote.id])).rows[0].count, 1);
});

test('HTTP creates quotes and orders, replays 200 and returns owned receipts without caching', async () => {
  const guest = randomUUID();
  const key = randomUUID();
  const quote = await http('/v1/checkout-quotes', { method: 'POST', guest, body: input() });
  assert.equal(quote.status, 201);
  const first = await http('/v1/orders', { method: 'POST', guest, key, body: { quoteId: quote.body.id } });
  assert.equal(first.status, 201);
  const replay = await http('/v1/orders', { method: 'POST', guest, key, body: { quoteId: quote.body.id } });
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, first.body);
  const receipt = await http(`/v1/orders/${first.body.id}`, { guest });
  assert.equal(receipt.status, 200);
  assert.match(receipt.headers.get('cache-control'), /no-store/);
  assert.deepEqual(receipt.body, first.body);
  assert.equal((await http(`/v1/orders/${first.body.id}`)).status, 404);
});

test('HTTP rejects missing authentication, guest identity, idempotency key, extra fields and bad JSON', async () => {
  assert.equal((await http('/health', { authorization: '' })).status, 200);
  for (const authorization of ['', 'Bearer wrong', `bearer ${secret}`, secret]) assert.equal((await http('/v1/checkout-quotes', { method: 'POST', body: input(), authorization })).status, 401);
  assert.equal((await http('/v1/checkout-quotes', { method: 'POST', guest: 'fake', body: input() })).status, 401);
  const quote = await service.createQuote(randomUUID(), input());
  assert.equal((await http('/v1/orders', { method: 'POST', body: { quoteId: quote.id } })).status, 400);
  assert.equal((await http('/v1/checkout-quotes', { method: 'POST', body: input({ totalCents: 1 }) })).status, 400);
  assert.equal((await http('/v1/checkout-quotes', { method: 'POST', body: '{bad' })).status, 400);
  assert.equal((await http('/v1/checkout-quotes', { method: 'POST', body: input(), headers: { 'content-type': 'application/json-malicious' } })).status, 415);
  assert.equal((await http('/v1/checkout-quotes?debug=true', { method: 'POST', body: input() })).status, 400);
});

test('HTTP bounds declared and chunked request bodies', async () => {
  assert.equal((await http('/v1/checkout-quotes', { method: 'POST', body: 'x'.repeat(16385) })).status, 413);
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(16385))); controller.close(); } });
  const result = await fetch(`${base}/v1/checkout-quotes`, { method: 'POST', body, duplex: 'half', headers: { authorization: `Bearer ${secret}`, 'x-guest-id': randomUUID(), 'content-type': 'application/json' } });
  assert.equal(result.status, 413);
  assert.equal((await result.json()).error.code, 'REQUEST_TOO_LARGE');
});

test('cleanup authentication is distinct from checkout authentication and logs contain no secrets', async () => {
  assert.equal((await http('/internal/cleanup')).status, 401);
  assert.equal((await http('/internal/cleanup', { authorization: `Bearer ${cronSecret}` })).status, 200);
  assert.equal((await http('/v1/orders', { method: 'POST', body: {}, authorization: `Bearer ${cronSecret}` })).status, 401);
  assert.ok(logs.length > 0);
  for (const line of logs) assert.deepEqual(Object.keys(line).sort(), ['durationMs', 'event', 'requestId', 'status']);
  assert.equal(JSON.stringify(logs).includes(secret), false);
});

test('unexpected database failures and missing configuration fail closed without leaking details', async () => {
  for (const configuration of [
    { secret: 'too-short', service },
    { secret, service: { createQuote() { throw new Error('postgres://private-password@host/database'); } } },
  ]) {
    const temporary = createServer(createHandler({ ...configuration, logger: () => {} }));
    await new Promise((resolve) => temporary.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${temporary.address().port}/v1/checkout-quotes`, { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json', 'x-guest-id': randomUUID() }, body: JSON.stringify(input()) });
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: { code: 'SERVICE_UNAVAILABLE', message: 'Orders are temporarily unavailable. Please retry with the same submission key.' } });
    } finally { await new Promise((resolve) => temporary.close(resolve)); }
  }
});

test('database connections verify remote TLS even when a connection URL requests weaker settings', () => {
  const remote = databaseConfig({ DATABASE_URL: 'postgres://user:pass@db.example.test/orders?sslmode=disable&sslrootcert=anything&ssl=false&uselibpqcompat=true' });
  assert.deepEqual(remote.ssl, { rejectUnauthorized: true });
  assert.equal(remote.connectionString.includes('sslmode'), false);
  assert.equal(remote.connectionString.includes('sslrootcert'), false);
  assert.equal(new URL(remote.connectionString).search, '');
  assert.equal(databaseConfig({ DATABASE_URL: process.env.DATABASE_URL }).ssl, false);
  assert.throws(() => databaseConfig({ DATABASE_URL: process.env.DATABASE_URL, VERCEL: '1' }), /remote database is required/);
});

test('retention cleanup deletes expired orders and replay rows but preserves live receipts and quotes', async () => {
  const guest = randomUUID();
  const quote = await service.createQuote(guest, input());
  const { order } = await service.createOrder(guest, { quoteId: quote.id }, randomUUID());
  const cleanupTime = new Date(Date.now() + 16 * 60000);
  await cleanupExpired(pool, cleanupTime);
  assert.deepEqual(await service.readOrder(guest, order.id), order);
  assert.equal((await pool.query('SELECT id FROM checkout_quotes WHERE id = $1', [quote.id])).rowCount, 1);
  const counts = await cleanupExpired(pool, new Date(Date.now() + 31 * 86400000));
  assert.ok(counts.orders > 0);
  assert.ok(counts.quotes > 0);
  assert.equal((await pool.query('SELECT * FROM order_submissions')).rowCount, 0);
  assert.equal((await pool.query('SELECT * FROM orders')).rowCount, 0);
  assert.equal((await pool.query('SELECT * FROM checkout_quotes')).rowCount, 0);
});
