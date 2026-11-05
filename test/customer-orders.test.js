import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { databaseConfig } from '../src/database.js';
import { migrate } from '../src/migrate.js';
import { OrderService } from '../src/service.js';
import { CustomerOrders } from '../src/customer-orders.js';

const schema = `customer_orders_${randomUUID().replaceAll('-', '')}`;
const code = (value) => (error) => error.code === value;
const input = (paymentProvider = 'simulated') => ({ items: [{ productId: 'demo-notebook', quantity: 1 }],
  shippingMethod: 'demo-standard', destination: { country: 'US', region: 'CA' }, paymentProvider });
const identity = (userId) => ({ userId, role: 'customer' });
let admin, pool, service, orders;
let sequence = 0;
before(async () => {
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.DATABASE_URL || 'invalid:').hostname), 'Customer order tests require disposable loopback PostgreSQL.');
  const config = databaseConfig({ DATABASE_URL: process.env.DATABASE_URL });
  admin = new pg.Pool(config);
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({ ...config, max: 12, options: `-c search_path=${schema}` });
  await migrate(pool);
  service = new OrderService(pool);
  orders = new CustomerOrders(pool);
});
after(async () => {
  if (pool) await pool.end();
  if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
});
async function shopper() {
  const userId = `customer-test-${++sequence}-${randomUUID()}`;
  await pool.query('INSERT INTO customer_users (id, name, email, "emailVerified") VALUES ($1, $2, $3, true)', [userId, 'Fixture Shopper', `${userId}@example.test`]);
  return identity(userId);
}
async function place(customer = null, instance = service) {
  const guest = randomUUID(); const key = randomUUID();
  const quote = await instance.createQuote(guest, input());
  const created = await instance.createOrder(guest, { quoteId: quote.id }, key, customer?.userId ?? null);
  return { ...created, guest, key, quote };
}

test('signed-in orders capture ownership atomically while guest checkout remains unchanged', async () => {
  const alice = await shopper(), bob = await shopper();
  const a = await place(alice), b = await place(bob), guest = await place();
  assert.equal((await pool.query('SELECT customer_user_id FROM orders WHERE id = $1', [a.order.id])).rows[0].customer_user_id, alice.userId);
  assert.equal((await pool.query('SELECT customer_user_id FROM orders WHERE id = $1', [guest.order.id])).rows[0].customer_user_id, null);
  assert.deepEqual((await orders.list(alice)).orders.map((order) => order.id), [a.order.id]);
  assert.deepEqual((await orders.list(bob)).orders.map((order) => order.id), [b.order.id]);
  assert.deepEqual(await orders.read(alice, a.order.id), a.order);
  assert.deepEqual(await service.readOrder(a.guest, a.order.id), a.order);
  for (const id of [b.order.id, guest.order.id, `order_${randomUUID()}`, 'invalid']) {
    await assert.rejects(orders.read(alice, id), (error) => error.code === 'ORDER_NOT_FOUND' && error.status === 404);
  }
  for (const caller of [undefined, { userId: alice.userId }, { ...alice, role: 'merchant' }, { userId: '', role: 'customer' }]) {
    await assert.rejects(orders.list(caller), code('AUTH_REQUIRED'));
    await assert.rejects(orders.read(caller, a.order.id), code('AUTH_REQUIRED'));
  }
});

test('order projections never expose customer, guest, session or recovery identities', async () => {
  const customer = await shopper(); const created = await place(customer);
  await pool.query("UPDATE orders SET receipt = receipt || $2::jsonb WHERE id = $1", [created.order.id, JSON.stringify({ customerId: customer.userId, guestId: created.guest, stripeSessionId: 'sensitive-session', idempotencyKey: created.key, email: 'private@example.test' })]);
  const detail = await orders.read(customer, created.order.id);
  const summary = await orders.list(customer);
  for (const value of [customer.userId, created.guest, created.key, 'sensitive-session', 'private@example.test']) {
    assert.equal(JSON.stringify(detail).includes(value), false);
    assert.equal(JSON.stringify(summary).includes(value), false);
  }
});

test('same-account retries recover one order and do not transfer guest or another customer ownership', async () => {
  const alice = await shopper(), bob = await shopper();
  const created = await place(alice);
  const replay = await service.createOrder(created.guest, { quoteId: created.quote.id }, created.key, alice.userId);
  assert.equal(replay.replayed, true); assert.equal(replay.order.id, created.order.id);
  for (const id of [null, bob.userId]) await assert.rejects(service.createOrder(created.guest, { quoteId: created.quote.id }, created.key, id), code('CUSTOMER_CHECKOUT_CHANGED'));
  const guest = await place();
  await assert.rejects(service.createOrder(guest.guest, { quoteId: guest.quote.id }, guest.key, alice.userId), code('CUSTOMER_CHECKOUT_CHANGED'));
  assert.equal((await pool.query('SELECT customer_user_id FROM orders WHERE id = $1', [created.order.id])).rows[0].customer_user_id, alice.userId);
  assert.equal((await pool.query('SELECT customer_user_id FROM orders WHERE id = $1', [guest.order.id])).rows[0].customer_user_id, null);
});

test('simultaneous account-switched submissions have one durable owner and one conflict', async () => {
  const alice = await shopper(), bob = await shopper();
  const guest = randomUUID(), key = randomUUID();
  const quote = await service.createQuote(guest, input());
  const results = await Promise.allSettled([alice, bob].map((customer) => service.createOrder(guest, { quoteId: quote.id }, key, customer.userId)));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'CUSTOMER_CHECKOUT_CHANGED');
  const row = (await pool.query('SELECT customer_user_id FROM orders WHERE quote_id = $1', [quote.id])).rows;
  assert.equal(row.length, 1);
  const winner = row[0].customer_user_id === alice.userId ? alice : bob;
  const loser = winner === alice ? bob : alice;
  assert.equal((await orders.list(winner)).orders.length, 1);
  assert.equal((await orders.list(loser)).orders.length, 0);
});

test('invalid customer identities and missing foreign-key owners cannot partially persist orders', async () => {
  const guest = randomUUID(), key = randomUUID();
  const quote = await service.createQuote(guest, input());
  for (const id of ['', 1, {}, 'a'.repeat(256)]) {
    await assert.rejects(service.createOrder(guest, { quoteId: quote.id }, key, id), code('INVALID_REQUEST'));
  }
  await assert.rejects(service.createOrder(guest, { quoteId: quote.id }, key, 'missing-user'));
  assert.equal((await pool.query('SELECT count(*)::int count FROM orders WHERE quote_id = $1', [quote.id])).rows[0].count, 0);
  assert.equal((await pool.query('SELECT count(*)::int count FROM order_submissions WHERE guest_id = $1', [guest])).rows[0].count, 0);
});

test('private history keyset pagination handles microsecond ties, new inserts, and foreign cursors without leaking orders', async () => {
  const alice = await shopper(), bob = await shopper();
  const records = [];
  for (let i = 0; i < 5; i++) {
    const record = await place(alice); records.push(record.order.id);
    await pool.query('UPDATE orders SET created_at = $2::timestamptz WHERE id = $1', [record.order.id, `2026-01-01T00:00:00.00000${i}Z`]);
  }
  const first = await orders.list(alice, new URLSearchParams('limit=2'));
  assert.deepEqual(first.orders.map((order) => order.id), records.slice(-2).reverse());
  assert.equal(first.pageInfo.hasMore, true);
  const newer = await place(alice);
  const next = await orders.list(alice, new URLSearchParams({ limit: '2', cursor: first.pageInfo.nextCursor }));
  assert.deepEqual(next.orders.map((order) => order.id), records.slice(1, 3).reverse());
  assert.equal(next.orders.some((order) => order.id === newer.order.id), false);
  assert.deepEqual((await orders.list(bob, new URLSearchParams({ cursor: first.pageInfo.nextCursor }))).orders, []);
  const last = await orders.list(alice, new URLSearchParams({ limit: '2', cursor: next.pageInfo.nextCursor }));
  assert.deepEqual(last.orders.map((order) => order.id), records.slice(0, 1));
  assert.deepEqual(last.pageInfo, { nextCursor: null, hasMore: false });
});

test('malformed pagination fails safely and does not let callers supply ownership filters', async () => {
  const customer = await shopper();
  for (const value of ['limit=0', 'limit=51', 'limit=2&limit=3', 'cursor=', 'cursor=not-a-cursor', 'userId=someone', 'status=paid']) {
    await assert.rejects(orders.list(customer, new URLSearchParams(value)), code('INVALID_CUSTOMER_QUERY'));
  }
});

test('resolved receipts expire while unresolved Stripe receipts retain private ownership', async () => {
  const customer = await shopper(); const resolved = await place(customer);
  const stripeService = new OrderService(pool, { stripeGateway: { params: (order) => ({ reference: order.id }) } });
  const guest = randomUUID(); const quote = await stripeService.createQuote(guest, input('stripe-test'));
  const unresolved = await stripeService.reserveOrder(guest, { quoteId: quote.id }, randomUUID(), 'stripe-test', customer.userId);
  await pool.query("UPDATE orders SET expires_at = now() - interval '1 day' WHERE id = ANY($1::text[])", [[resolved.order.id, unresolved.order.id]]);
  await assert.rejects(orders.read(customer, resolved.order.id), code('ORDER_NOT_FOUND'));
  assert.equal((await orders.read(customer, unresolved.order.id)).paymentStatus, 'PENDING');
  assert.deepEqual((await orders.list(customer)).orders.map((order) => order.id), [unresolved.order.id]);
});

test('Stripe session creation failures preserve the original shopper ownership for recovery', async () => {
  const customer = await shopper(), other = await shopper();
  const guest = randomUUID(), key = randomUUID();
  const stripe = { params: (order) => ({ reference: order.id }), create: async () => { throw new Error('provider timeout'); } };
  const instance = new OrderService(pool, { stripeGateway: stripe });
  const quote = await instance.createQuote(guest, input('stripe-test'));
  await assert.rejects(instance.createPaymentSession(guest, { quoteId: quote.id }, key, customer.userId), code('PAYMENT_UNAVAILABLE'));
  const original = (await orders.list(customer)).orders[0];
  assert.equal(original.paymentStatus, 'PENDING');
  await assert.rejects(instance.createPaymentSession(guest, { quoteId: quote.id }, key, other.userId), code('CUSTOMER_CHECKOUT_CHANGED'));
  await assert.rejects(instance.createPaymentSession(guest, { quoteId: quote.id }, key, customer.userId), code('PAYMENT_UNAVAILABLE'));
  assert.equal((await orders.list(customer)).orders[0].id, original.id);
  assert.deepEqual((await orders.list(other)).orders, []);
});
