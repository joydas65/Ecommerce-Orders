import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import Stripe from 'stripe';
import pg from 'pg';
import { createHandler } from '../src/api.js';
import { cleanupExpired } from '../src/cleanup.js';
import { databaseConfig } from '../src/database.js';
import { migrate } from '../src/migrate.js';
import { OrderService } from '../src/service.js';
import { checkoutUrl, createStripeGateway, stripeApiVersion, stripeGatewayFromEnv, storefrontOrigin } from '../src/stripe-gateway.js';

const schema = `stripe_test_${randomUUID().replaceAll('-', '')}`;
const secret = 'test-orders-secret-0123456789-abcdef';
const webhookSecret = 'whsec_fixtureSigningSecret';
const signing = new Stripe('sk_test_fixture', { apiVersion: stripeApiVersion });
const clone = (value) => structuredClone(value);
const input = (paymentProvider = 'stripe-test') => ({ paymentProvider, items: [{ productId: 'demo-notebook', quantity: 2 }], shippingMethod: 'demo-standard', destination: { country: 'US', region: 'CA' } });
const code = (expected) => (error) => error.code === expected;
let admin;
let pool;

before(async () => {
  assert.ok(process.env.DATABASE_URL, 'Real local PostgreSQL is required.');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.DATABASE_URL).hostname));
  const config = databaseConfig({ DATABASE_URL: process.env.DATABASE_URL });
  admin = new pg.Pool(config);
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({ ...config, max: 12, options: `-c search_path=${schema}` });
  await migrate(pool);
});
after(async () => {
  if (pool) await pool.end();
  if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
});

function harness(options = {}) {
  const sessions = new Map();
  const keys = new Map();
  const creates = [];
  const retrieves = [];
  const expires = [];
  const sdk = { webhooks: signing.webhooks, checkout: { sessions: {
    async create(params, { idempotencyKey }) {
      creates.push({ params: clone(params), key: idempotencyKey });
      let session = keys.get(idempotencyKey);
      if (!session) {
        const shipping = params.shipping_options[0].shipping_rate_data.fixed_amount.amount;
        const lines = params.line_items.map((item) => ({ description: item.price_data.product_data.name,
          quantity: item.quantity, currency: 'usd', price: { currency: 'usd', unit_amount: item.price_data.unit_amount },
          amount_subtotal: item.quantity * item.price_data.unit_amount, amount_total: item.quantity * item.price_data.unit_amount }));
        const id = `cs_test_${randomUUID().replaceAll('-', '')}`;
        session = { id, livemode: false, mode: 'payment', currency: 'usd', status: 'open', payment_status: 'unpaid',
          amount_total: lines.reduce((sum, item) => sum + item.amount_total, shipping),
          client_reference_id: params.client_reference_id, metadata: clone(params.metadata), payment_intent: null,
          expires_at: Math.floor(Date.now() / 1000) + 86400, url: `https://checkout.stripe.com/c/pay/${id}`,
          line_items: { data: lines, has_more: false }, total_details: { amount_shipping: shipping, amount_tax: 0, amount_discount: 0 } };
        keys.set(idempotencyKey, session);
        sessions.set(id, session);
      }
      if (options.onCreate) await options.onCreate(session, params, idempotencyKey);
      return clone(session);
    },
    async retrieve(id, params) {
      retrieves.push({ id, params });
      if (options.onRetrieve) return options.onRetrieve(sessions.get(id));
      if (!sessions.has(id)) throw new Error('Stripe Session unavailable');
      return clone(sessions.get(id));
    },
    async expire(id, body, requestOptions) {
      expires.push({ id, body, requestOptions });
      const session = sessions.get(id);
      if (options.onExpire) await options.onExpire(session);
      else if (session.status === 'open') { session.status = 'expired'; session.url = null; }
      else throw new Error('Session no longer open');
      return clone(session);
    },
  } } };
  const gateway = createStripeGateway({ stripeClient: sdk, storefrontOrigin: 'https://store.example', webhookSecret });
  const service = new OrderService(pool, { stripeGateway: gateway, ...(options.now ? { now: options.now } : {}) });
  return { service, gateway, sessions, keys, creates, retrieves, expires };
}

async function start(h) {
  const guest = randomUUID();
  const key = randomUUID();
  const quote = await h.service.createQuote(guest, input());
  const result = await h.service.createPaymentSession(guest, { quoteId: quote.id }, key);
  const session = [...h.sessions.values()].find((value) => value.metadata.orderId === result.order.id);
  return { guest, key, quote, result, session };
}
function paid(session) { session.status = 'complete'; session.payment_status = 'paid'; session.payment_intent = `pi_${randomUUID().replaceAll('-', '')}`; session.url = null; }
function signed(session, type = 'checkout.session.completed', overrides = {}) {
  const event = { id: `evt_${randomUUID().replaceAll('-', '')}`, livemode: false, type, data: { object: clone(session) }, ...overrides };
  const raw = Buffer.from(JSON.stringify(event));
  return { event, raw, signature: signing.webhooks.generateTestHeaderString({ payload: raw.toString(), secret: webhookSecret }) };
}

test('Stripe is opt-in and production configuration rejects live keys or unsafe return origins', () => {
  assert.equal(stripeGatewayFromEnv({}), null);
  const env = { STRIPE_PAYMENTS_ENABLED: 'true', STRIPE_SECRET_KEY: 'sk_test_fixture', STRIPE_WEBHOOK_SECRET: webhookSecret, STOREFRONT_ORIGIN: 'https://store.example' };
  assert.ok(stripeGatewayFromEnv(env));
  for (const change of [{ STRIPE_SECRET_KEY: 'sk_live_fixture' }, { STRIPE_SECRET_KEY: '' }, { STRIPE_WEBHOOK_SECRET: '' },
    { STOREFRONT_ORIGIN: 'http://store.example' }, { STOREFRONT_ORIGIN: 'https://user:pass@store.example' },
    { STOREFRONT_ORIGIN: 'https://store.example/path' }, { STOREFRONT_ORIGIN: 'https://store.example?next=evil' }]) assert.throws(() => stripeGatewayFromEnv({ ...env, ...change }));
  assert.equal(storefrontOrigin({ STOREFRONT_ORIGIN: 'http://127.0.0.1:3100', ORDERS_ALLOW_LOCAL_STOREFRONT: 'true' }), 'http://127.0.0.1:3100');
  assert.throws(() => storefrontOrigin({ STOREFRONT_ORIGIN: 'http://127.0.0.1:3100', ORDERS_ALLOW_LOCAL_STOREFRONT: 'true', VERCEL: '1' }));
  for (const url of ['https://evil.example/pay', 'http://checkout.stripe.com/pay', 'https://checkout.stripe.com.evil.example/pay', 'https://user:pass@checkout.stripe.com/pay']) assert.equal(checkoutUrl(url), null);
});

test('disabled Stripe never falls back to simulated orders', async () => {
  const service = new OrderService(pool);
  await assert.rejects(service.createQuote(randomUUID(), input()), code('PAYMENTS_DISABLED'));
  await assert.rejects(service.createPaymentSession(randomUUID(), { quoteId: `quote_${randomUUID()}` }, randomUUID()), code('PAYMENTS_DISABLED'));
});

test('reserves an unpaid private order before calling Stripe and sends only authoritative prices', async () => {
  const h = harness({ onCreate: async (session) => {
    const row = (await pool.query('SELECT o.receipt, s.order_id FROM orders o JOIN order_submissions s ON s.order_id=o.id WHERE o.id=$1', [session.metadata.orderId])).rows[0];
    assert.equal(row.receipt.status, 'PENDING_PAYMENT');
    assert.equal(row.receipt.paymentStatus, 'PENDING');
  } });
  const { guest, result } = await start(h);
  assert.equal(result.replayed, false);
  assert.equal(result.order.totalCents, 3132);
  assert.equal(result.order.paymentProvider, 'stripe-test');
  assert.equal(result.order.paymentMode, 'test');
  assert.match(result.order.reference, /^TEST-/);
  assert.match(result.checkoutUrl, /^https:\/\/checkout\.stripe\.com\//);
  assert.deepEqual(await h.service.readOrder(guest, result.order.id), result.order);
  await assert.rejects(h.service.readOrder(randomUUID(), result.order.id), code('ORDER_NOT_FOUND'));
  const params = h.creates[0].params;
  assert.deepEqual(params.metadata, { orderId: result.order.id });
  assert.deepEqual(params.allowed_payment_method_types, ['card']);
  assert.equal(Object.hasOwn(params, 'payment_method_types'), false);
  assert.equal(params.mode, 'payment');
  assert.equal(params.line_items[0].price_data.unit_amount, 1200);
  assert.equal(params.line_items[0].quantity, 2);
  assert.equal(params.success_url, `https://store.example/orders/${result.order.id}?checkout=return`);
  assert.equal(params.cancel_url, `https://store.example/orders/${result.order.id}?checkout=cancel`);
  assert.equal(Object.hasOwn(params, 'expires_at'), false);
  assert.equal(JSON.stringify(params).includes('guest'), false);
});

test('provider-bound quotes and submission keys cannot switch between Stripe and simulation', async () => {
  const h = harness();
  const guest = randomUUID();
  const stripeQuote = await h.service.createQuote(guest, input());
  const simulatedQuote = await h.service.createQuote(guest, input('simulated'));
  const key = randomUUID();
  await assert.rejects(h.service.createOrder(guest, { quoteId: stripeQuote.id }, key), code('PAYMENT_PROVIDER_MISMATCH'));
  await assert.rejects(h.service.createPaymentSession(guest, { quoteId: simulatedQuote.id }, key), code('PAYMENT_PROVIDER_MISMATCH'));
  await h.service.createOrder(guest, { quoteId: simulatedQuote.id }, key);
  await assert.rejects(h.service.createPaymentSession(guest, { quoteId: stripeQuote.id }, key), code('PAYMENT_PROVIDER_MISMATCH'));
  const anotherKey = randomUUID();
  await h.service.createPaymentSession(guest, { quoteId: stripeQuote.id }, anotherKey);
  await assert.rejects(h.service.createOrder(guest, { quoteId: simulatedQuote.id }, anotherKey), code('PAYMENT_PROVIDER_MISMATCH'));
});

test('preserves legacy simulated replay fingerprints without allowing cross-provider replay', async () => {
  const h = harness();
  const guest = randomUUID();
  const key = randomUUID();
  const quote = await h.service.createQuote(guest, input('simulated'));
  const created = await h.service.createOrder(guest, { quoteId: quote.id }, key);
  const oldFingerprint = createHash('sha256').update(quote.id).digest('hex');
  await pool.query('UPDATE order_submissions SET fingerprint=$1 WHERE order_id=$2', [oldFingerprint, created.order.id]);
  assert.deepEqual(await h.service.createOrder(guest, { quoteId: quote.id }, key), { ...created, replayed: true });
  await assert.rejects(h.service.createPaymentSession(guest, { quoteId: quote.id }, key), code('PAYMENT_PROVIDER_MISMATCH'));
});

test('concurrent retries create one order and one Stripe Session using one immutable provider key', async () => {
  const h = harness();
  const guest = randomUUID();
  const key = randomUUID();
  const quote = await h.service.createQuote(guest, input());
  const results = await Promise.all(Array.from({ length: 8 }, () => h.service.createPaymentSession(guest, { quoteId: quote.id }, key)));
  assert.equal(new Set(results.map((result) => result.order.id)).size, 1);
  assert.equal(results.filter((result) => !result.replayed).length, 1);
  assert.equal(h.sessions.size, 1);
  assert.equal(new Set(h.creates.map((call) => call.key)).size, 1);
  for (const call of h.creates) assert.deepEqual(call.params, h.creates[0].params);
  await assert.rejects(h.service.createPaymentSession(guest, { quoteId: quote.id }, randomUUID()), code('QUOTE_CONSUMED'));
  const otherQuote = await h.service.createQuote(guest, input());
  await assert.rejects(h.service.createPaymentSession(guest, { quoteId: otherQuote.id }, key), code('IDEMPOTENCY_CONFLICT'));
});

test('lost Session creation responses replay identical parameters after the quote expires', async () => {
  let lose = true;
  const h = harness({ onCreate: () => { if (lose) { lose = false; throw new Error('Response lost after Stripe created Session'); } } });
  const guest = randomUUID();
  const key = randomUUID();
  const quote = await h.service.createQuote(guest, input());
  await assert.rejects(h.service.createPaymentSession(guest, { quoteId: quote.id }, key), code('PAYMENT_UNAVAILABLE'));
  const fresh = new OrderService(pool, { stripeGateway: h.gateway, now: () => new Date(Date.now() + 20 * 60000) });
  const retried = await fresh.createPaymentSession(guest, { quoteId: quote.id }, key);
  assert.equal(retried.replayed, true);
  assert.equal(retried.order.status, 'PENDING_PAYMENT');
  assert.equal(h.sessions.size, 1);
  assert.deepEqual(h.creates[1], h.creates[0]);
});

test('uncertain creation beyond 23 hours becomes review without creating another Session', async () => {
  const h = harness({ onCreate: () => { throw new Error('Cached Stripe 500'); } });
  const guest = randomUUID();
  const key = randomUUID();
  const quote = await h.service.createQuote(guest, input());
  await assert.rejects(h.service.createPaymentSession(guest, { quoteId: quote.id }, key), code('PAYMENT_UNAVAILABLE'));
  const fresh = new OrderService(pool, { stripeGateway: h.gateway, now: () => new Date(Date.now() + 24 * 3600000) });
  const result = await fresh.createPaymentSession(guest, { quoteId: quote.id }, key);
  assert.equal(result.order.status, 'PAYMENT_REVIEW');
  assert.equal(result.order.paymentStatus, 'REQUIRES_REVIEW');
  assert.equal(result.checkoutUrl, null);
  assert.equal(h.creates.length, 1);
});

test('a Session creation response claiming paid still requires fresh server-side verification', async () => {
  const h = harness({ onCreate: (session) => paid(session) });
  const { guest, result } = await start(h);
  assert.equal(result.order.status, 'PENDING_PAYMENT');
  assert.equal(result.checkoutUrl, null);
  const verified = await h.service.reconcileOrder(guest, result.order.id);
  assert.equal(verified.order.paymentStatus, 'PAID');
});

test('return-page reconciliation confirms only a retrieved paid Session and never regresses', async () => {
  const h = harness();
  const { guest, result, session } = await start(h);
  assert.equal((await h.service.reconcileOrder(guest, result.order.id)).order.status, 'PENDING_PAYMENT');
  paid(session);
  const confirmed = await h.service.reconcileOrder(guest, result.order.id);
  assert.equal(confirmed.order.status, 'CONFIRMED');
  assert.equal(confirmed.order.paymentStatus, 'PAID');
  assert.equal(confirmed.checkoutUrl, null);
  session.status = 'expired'; session.payment_status = 'unpaid';
  const event = signed(session, 'checkout.session.expired');
  await h.service.webhook(event.raw, event.signature);
  assert.deepEqual(await h.service.readOrder(guest, result.order.id), confirmed.order);
});

test('signed webhook can arrive before Session creation is attached to the order', async () => {
  let h;
  h = harness({ onCreate: async (session) => {
    paid(session);
    const event = signed(session);
    await h.service.webhook(event.raw, event.signature);
  } });
  const { result } = await start(h);
  assert.equal(result.order.status, 'CONFIRMED');
  assert.equal(result.order.paymentStatus, 'PAID');
  assert.equal((await pool.query('SELECT stripe_session_id FROM payment_sessions WHERE order_id=$1', [result.order.id])).rows[0].stripe_session_id, [...h.sessions.keys()][0]);
});

test('duplicate webhooks and concurrent reconciliation produce one paid receipt and deduplicate event IDs', async () => {
  const h = harness();
  const { guest, result, session } = await start(h);
  paid(session);
  const event = signed(session);
  await Promise.all([h.service.webhook(event.raw, event.signature), h.service.webhook(event.raw, event.signature), h.service.reconcileOrder(guest, result.order.id)]);
  assert.equal((await h.service.readOrder(guest, result.order.id)).paymentStatus, 'PAID');
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM stripe_events WHERE event_id=$1', [event.event.id])).rows[0].count, 1);
});

test('bad signatures, altered payloads and live events never mutate an order', async () => {
  const h = harness();
  const { guest, result, session } = await start(h);
  paid(session);
  const event = signed(session);
  await assert.rejects(h.service.webhook(event.raw, 'invalid'), code('INVALID_WEBHOOK'));
  await assert.rejects(h.service.webhook(Buffer.from(`${event.raw} `), event.signature), code('INVALID_WEBHOOK'));
  const live = signed(session, 'checkout.session.completed', { livemode: true });
  await assert.rejects(h.service.webhook(live.raw, live.signature), code('INVALID_WEBHOOK'));
  assert.equal((await h.service.readOrder(guest, result.order.id)).status, 'PENDING_PAYMENT');
});

for (const [label, tamper] of [
  ['amount', (session) => { session.amount_total += 1; }],
  ['currency', (session) => { session.currency = 'eur'; }],
  ['live mode', (session) => { session.livemode = true; }],
  ['Session mode', (session) => { session.mode = 'subscription'; }],
  ['metadata ownership', (session) => { session.metadata.orderId = `order_${randomUUID()}`; }],
  ['reference', (session) => { session.client_reference_id = `order_${randomUUID()}`; }],
  ['Session identity', (session) => { session.id = 'cs_test_unrelated'; }],
  ['missing PaymentIntent', (session) => { session.payment_intent = null; }],
  ['line items', (session) => { session.line_items.data[0].quantity = 99; }],
  ['shipping', (session) => { session.total_details.amount_shipping = 0; }],
]) test(`a retrieved paid Session with mismatched ${label} is held for review`, async () => {
  const h = harness();
  const { guest, result, session } = await start(h);
  paid(session);
  tamper(session);
  const review = await h.service.reconcileOrder(guest, result.order.id);
  assert.equal(review.order.status, 'PAYMENT_REVIEW');
  assert.equal(review.order.paymentStatus, 'REQUIRES_REVIEW');
  assert.equal(review.checkoutUrl, null);
});

test('cancel confirms expiration, while a payment that wins the race remains paid', async () => {
  const h = harness();
  const opened = await start(h);
  assert.equal((await h.service.cancelOrder(opened.guest, opened.result.order.id)).order.status, 'CANCELED');
  assert.equal(h.expires.length, 1);
  const racing = harness({ onExpire: (session) => { paid(session); throw new Error('Already completed'); } });
  const other = await start(racing);
  const result = await racing.service.cancelOrder(other.guest, other.result.order.id);
  assert.equal(result.order.status, 'CONFIRMED');
  assert.equal(result.order.paymentStatus, 'PAID');
});

test('a failed expiration never falsely cancels an open payable Session', async () => {
  const h = harness({ onExpire: () => { throw new Error('Network unavailable'); } });
  const { guest, result } = await start(h);
  const response = await h.service.cancelOrder(guest, result.order.id);
  assert.equal(response.order.status, 'PENDING_PAYMENT');
  assert.ok(response.checkoutUrl);
});

test('foreign owners cannot reconcile or cancel a payment', async () => {
  const h = harness();
  const { result } = await start(h);
  await assert.rejects(h.service.reconcileOrder(randomUUID(), result.order.id), code('ORDER_NOT_FOUND'));
  await assert.rejects(h.service.cancelOrder(randomUUID(), result.order.id), code('ORDER_NOT_FOUND'));
  assert.equal(h.retrieves.length, 0);
  assert.equal(h.expires.length, 0);
});

test('async failure is review, unknown signed events are ignored, and unpaid completion is pending', async () => {
  const h = harness();
  const { guest, result, session } = await start(h);
  session.status = 'complete'; session.url = null;
  const pending = signed(session);
  await h.service.webhook(pending.raw, pending.signature);
  assert.equal((await h.service.readOrder(guest, result.order.id)).status, 'PENDING_PAYMENT');
  const unknown = signed(session, 'customer.created');
  await h.service.webhook(unknown.raw, unknown.signature);
  assert.equal((await pool.query('SELECT * FROM stripe_events WHERE event_id=$1', [unknown.event.id])).rowCount, 0);
  const failed = signed(session, 'checkout.session.async_payment_failed');
  await h.service.webhook(failed.raw, failed.signature);
  assert.equal((await h.service.readOrder(guest, result.order.id)).status, 'PAYMENT_REVIEW');
});

test('HTTP session, reconcile and cancel routes require service auth while webhook requires its signature', async () => {
  const h = harness();
  const server = createServer(createHandler({ service: h.service, secret, logger: () => {} }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const guest = randomUUID();
  const key = randomUUID();
  const post = (path, body, headers = {}) => fetch(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}`, 'x-guest-id': guest, 'idempotency-key': key, ...headers }, body: typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body) });
  try {
    const quote = await (await post('/v1/checkout-quotes', input())).json();
    const response = await post('/v1/payment-sessions', { quoteId: quote.id });
    assert.equal(response.status, 201);
    const { order } = await response.json();
    assert.equal(order.status, 'PENDING_PAYMENT');
    assert.equal((await post('/v1/payment-sessions', { quoteId: quote.id })).status, 200);
    assert.equal((await post(`/v1/orders/${order.id}/reconcile`, {}, { authorization: '' })).status, 401);
    assert.equal((await post(`/v1/orders/${order.id}/reconcile`, { totalCents: 1 })).status, 400);
    assert.equal((await (await post(`/v1/orders/${order.id}/reconcile`, {})).json()).order.status, 'PENDING_PAYMENT');
    const session = [...h.sessions.values()][0];
    paid(session);
    const event = signed(session);
    const delivered = await post('/v1/webhooks/stripe', event.raw, { authorization: '', 'stripe-signature': event.signature });
    assert.equal(delivered.status, 200);
    assert.equal((await (await post(`/v1/orders/${order.id}/cancel`, {})).json()).order.status, 'CONFIRMED');
    assert.equal((await post('/v1/webhooks/stripe', event.raw, { 'stripe-signature': 'invalid' })).status, 400);
    assert.equal((await post('/v1/webhooks/stripe', 'x'.repeat(262145))).status, 413);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('cleanup retains unresolved Stripe orders, submission keys and quotes beyond thirty days', async () => {
  const h = harness();
  const { guest, result, key, quote } = await start(h);
  const future = new Date(Date.now() + 31 * 86400000);
  await cleanupExpired(pool, future);
  assert.equal((await pool.query('SELECT * FROM payment_sessions WHERE order_id=$1', [result.order.id])).rowCount, 1);
  assert.equal((await pool.query('SELECT * FROM order_submissions WHERE order_id=$1', [result.order.id])).rowCount, 1);
  const resumed = new OrderService(pool, { stripeGateway: h.gateway, now: () => future });
  assert.equal((await resumed.readOrder(guest, result.order.id)).status, 'PENDING_PAYMENT');
  assert.equal((await resumed.createPaymentSession(guest, { quoteId: quote.id }, key)).order.id, result.order.id);
});

function transactionPool(intercept) {
  return {
    query: (...args) => pool.query(...args),
    connect: async () => {
      const client = await pool.connect();
      return { release: (...args) => client.release(...args), query: (sql, args) => intercept(sql, args, client) };
    },
  };
}

test('a failed Session attachment is recovered with the original provider key and request', async () => {
  const h = harness();
  const failedPool = transactionPool((sql, args, client) => {
    if (sql.startsWith('UPDATE payment_sessions SET stripe_session_id')) throw new Error('Injected attachment failure');
    return client.query(sql, args);
  });
  const failed = new OrderService(failedPool, { stripeGateway: h.gateway });
  const guest = randomUUID();
  const key = randomUUID();
  const quote = await failed.createQuote(guest, input());
  await assert.rejects(failed.createPaymentSession(guest, { quoteId: quote.id }, key), /attachment failure/);
  const pending = (await pool.query('SELECT receipt FROM orders WHERE quote_id=$1', [quote.id])).rows[0].receipt;
  assert.equal(pending.status, 'PENDING_PAYMENT');
  const recovered = await h.service.createPaymentSession(guest, { quoteId: quote.id }, key);
  assert.equal(recovered.order.id, pending.id);
  assert.equal(h.sessions.size, 1);
  assert.deepEqual(h.creates[1], h.creates[0]);
});

test('a lost attachment COMMIT response recovers by retrieving the attached Session', async () => {
  const h = harness();
  let commits = 0;
  const ambiguousPool = transactionPool(async (sql, args, client) => {
    const result = await client.query(sql, args);
    if (sql === 'COMMIT' && ++commits === 2) throw new Error('Injected lost attachment response');
    return result;
  });
  const failed = new OrderService(ambiguousPool, { stripeGateway: h.gateway });
  const guest = randomUUID();
  const key = randomUUID();
  const quote = await failed.createQuote(guest, input());
  await assert.rejects(failed.createPaymentSession(guest, { quoteId: quote.id }, key), /lost attachment response/);
  const recovered = await h.service.createPaymentSession(guest, { quoteId: quote.id }, key);
  assert.equal(recovered.order.status, 'PENDING_PAYMENT');
  assert.equal(h.creates.length, 1);
  assert.equal(h.retrieves.length, 1);
});

test('webhook persistence failure returns 503 and rolls back confirmation before Stripe retries', async () => {
  const h = harness();
  const { guest, result, session } = await start(h);
  paid(session);
  const event = signed(session);
  let fail = true;
  const faultPool = transactionPool((sql, args, client) => {
    if (fail && sql.startsWith('INSERT INTO stripe_events')) throw new Error(`Injected failure ${secret}`);
    return client.query(sql, args);
  });
  const service = new OrderService(faultPool, { stripeGateway: h.gateway });
  const server = createServer(createHandler({ service, secret, logger: () => {} }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const deliver = () => fetch(`http://127.0.0.1:${server.address().port}/v1/webhooks/stripe`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': event.signature }, body: event.raw });
  try {
    const failed = await deliver();
    assert.equal(failed.status, 503);
    assert.equal((await failed.text()).includes(secret), false);
    assert.equal((await h.service.readOrder(guest, result.order.id)).status, 'PENDING_PAYMENT');
    assert.equal((await pool.query('SELECT * FROM stripe_events WHERE event_id=$1', [event.event.id])).rowCount, 0);
    fail = false;
    assert.equal((await deliver()).status, 200);
    assert.equal((await h.service.readOrder(guest, result.order.id)).paymentStatus, 'PAID');
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('a stale unpaid webhook retrieval cannot reopen a concurrently canceled Session', async () => {
  let release;
  let ready;
  const fetched = new Promise((resolve) => { ready = resolve; });
  const hold = new Promise((resolve) => { release = resolve; });
  let first = true;
  const h = harness({ onRetrieve: async (session) => {
    const snapshot = clone(session);
    if (first) { first = false; ready(); await hold; }
    return snapshot;
  } });
  const { guest, result, session } = await start(h);
  const event = signed(session, 'checkout.session.async_payment_failed');
  const webhook = h.service.webhook(event.raw, event.signature);
  await fetched;
  assert.equal((await h.service.cancelOrder(guest, result.order.id)).order.status, 'CANCELED');
  release();
  await webhook;
  assert.equal((await h.service.readOrder(guest, result.order.id)).status, 'CANCELED');
});

test('canonical stored Session and PaymentIntent bindings cannot be replaced', async () => {
  for (const column of ['stripe_session_id', 'payment_intent_id']) {
    const h = harness();
    const { guest, result, session } = await start(h);
    paid(session);
    const replacement = `${column === 'stripe_session_id' ? 'cs_test' : 'pi'}_${randomUUID().replaceAll('-', '')}`;
    await pool.query(`UPDATE payment_sessions SET ${column}=$1 WHERE order_id=$2`, [replacement, result.order.id]);
    const event = signed(session);
    await h.service.webhook(event.raw, event.signature);
    assert.equal((await h.service.readOrder(guest, result.order.id)).status, 'PAYMENT_REVIEW');
    assert.equal((await pool.query(`SELECT ${column} FROM payment_sessions WHERE order_id=$1`, [result.order.id])).rows[0][column], replacement);
  }
});
