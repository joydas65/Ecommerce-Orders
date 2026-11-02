import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import Stripe from 'stripe';
import pg from 'pg';
import { createHandler } from '../src/api.js';
import { cleanupExpired } from '../src/cleanup.js';
import { databaseConfig } from '../src/database.js';
import { migrate } from '../src/migrate.js';
import { OrderService } from '../src/service.js';
import { MerchantOrders } from '../src/merchant-orders.js';
import { MerchantPaymentChecks } from '../src/merchant-payment-checks.js';
import { createMerchantAuth } from '../src/merchant-auth.js';
import { seedMerchantSessions } from '../scripts/test/seed-merchant-session.mjs';
import { createStripeGateway, stripeApiVersion } from '../src/stripe-gateway.js';
const schema = `payment_check_test_${randomUUID().replaceAll('-', '')}`;
const webhookSecret = 'whsec_fixtureSigningSecret';
const signing = new Stripe('sk_test_fixture', { apiVersion: stripeApiVersion });
const clone = (value) => structuredClone(value);
const input = (paymentProvider = 'stripe-test') => ({ paymentProvider, items: [{ productId: 'demo-notebook', quantity: 2 }], shippingMethod: 'demo-standard', destination: { country: 'US', region: 'CA' } });
const code = (expected) => (error) => error.code === expected;
let admin;
let pool;
before(async () => {
  const url = new URL(process.env.DATABASE_URL || 'invalid:');
  assert.ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname));
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


async function setup(options = {}) {
  let clock = new Date();
  const h = harness({ ...options, now: () => clock });
  h.actor = { userId: `merchant_${randomUUID()}`, role: 'merchant' };
  await pool.query('INSERT INTO merchant_users (id,name,email,"emailVerified") VALUES ($1,$2,$3,true)', [h.actor.userId, options.name || 'Fixture Merchant', `${randomUUID()}@fixture.test`]);
  h.checks = new MerchantPaymentChecks(pool, { service: h.service, now: () => clock });
  h.advance = (ms) => { clock = new Date(clock.getTime() + ms); };
  h.currentTime = () => clock;
  return { ...h, ...await start(h) };
}
const request = () => ({ requestId: randomUUID() });
const check = (h, body = request()) => h.checks.recheck(h.actor, h.result.order.id, body);
const history = (h) => h.checks.history(h.actor, h.result.order.id);
function latch() { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; }

test('retrieves only an existing session, records requested/result in order, and replays latest order without a provider call', async () => {
  const h = await setup(); const body = request();
  const result = await check(h, body);
  assert.equal(result.check.outcome, 'pending'); assert.equal(result.replayed, false);
  assert.deepEqual(result.check.actor, { id: h.actor.userId, displayName: 'Fixture Merchant' });
  assert.equal(h.creates.length, 1); assert.equal(h.expires.length, 0); assert.equal(h.retrieves.length, 1);
  const page = await history(h);
  assert.deepEqual(page.events.map((e) => e.outcome), ['pending','requested']);
  assert.equal(page.events[0].occurredAt, page.events[1].occurredAt);
  assert.equal(page.eligibility.reason, 'cooldown'); assert.equal(page.hasMore, false);
  paid(h.session); const event = signed(h.session); await h.service.webhook(event.raw, event.signature);
  const replay = await check(h, body);
  assert.equal(replay.replayed, true); assert.equal(replay.check.id, result.check.id);
  assert.equal(replay.check.resultPaymentStatus, 'PENDING'); assert.equal(replay.order.paymentStatus, 'PAID');
  assert.equal(h.retrieves.length, 2); assert.equal((await history(h)).events.length, 2);
  for (const forbidden of ['guest_id','session_id','payment_intent','checkoutUrl','create_key','email']) assert.ok(!JSON.stringify(result).includes(forbidden));
});

test('verified paid and expired sessions become paid/canceled with atomic audit statuses', async () => {
  for (const state of ['paid','expired']) {
    const h = await setup();
    if (state === 'paid') paid(h.session); else { h.session.status = 'expired'; h.session.url = null; }
    const result = await check(h);
    assert.equal(result.check.outcome, state === 'paid' ? 'paid' : 'canceled');
    assert.equal(result.check.previousPaymentStatus, 'PENDING');
    assert.equal(result.check.resultPaymentStatus, result.order.paymentStatus);
    assert.equal((await history(h)).eligibility.reason, 'resolved');
    await assert.rejects(check(h), code('PAYMENT_CHECK_NOT_ELIGIBLE'));
    assert.equal(h.retrieves.length, 1);
  }
});

test('amount/session/item/intent/live-mode mismatches and null payload are review outcomes, never payment success', async () => {
  for (const mutate of [s => { s.amount_total++; }, s => { s.id = 'cs_test_wrong'; }, s => { s.livemode = true; }, s => { s.line_items.data[0].quantity++; }, s => { s.payment_intent = 'pi_wrong'; }, () => null]) {
    const h = await setup(); paid(h.session);
    if (mutate.toString().includes('pi_wrong')) await pool.query('UPDATE payment_sessions SET payment_intent_id = $2 WHERE order_id=$1', [h.result.order.id, 'pi_original']);
    const changed = mutate(h.session);
    if (changed === null) h.gateway.retrieve = async () => null;
    const result = await check(h);
    assert.equal(result.check.outcome, 'review_required'); assert.equal(result.order.paymentStatus, 'REQUIRES_REVIEW');
  }
});

test('provider network failure or timeout saves a failure outcome and retries only with a new request after cooldown', async () => {
  for (const message of ['network failed', 'StripeConnectionError: Request aborted due to timeout']) {
    const h = await setup({ onRetrieve: async () => { throw new Error(message); } }); const body = request();
    const result = await check(h, body);
    assert.equal(result.check.outcome, 'provider_unavailable'); assert.equal(result.order.paymentStatus, 'PENDING');
    assert.ok(!JSON.stringify(result).includes(message));
    assert.equal((await check(h, body)).replayed, true); assert.equal(h.retrieves.length, 1);
    await assert.rejects(check(h), code('PAYMENT_CHECK_RATE_LIMITED'));
    h.advance(10_000); await check(h); assert.equal(h.retrieves.length, 2);
  }
});

test('simulated/resolved/missing-session/disabled-provider orders cannot initiate checks', async () => {
  const h = await setup();
  await pool.query('UPDATE payment_sessions SET stripe_session_id=NULL WHERE order_id=$1', [h.result.order.id]);
  assert.equal((await history(h)).eligibility.reason, 'missing_session'); await assert.rejects(check(h), code('PAYMENT_CHECK_NOT_ELIGIBLE'));
  const disabled = new MerchantPaymentChecks(pool, { service: new OrderService(pool) });
  assert.equal((await disabled.history(h.actor, h.result.order.id)).eligibility.reason, 'payments_disabled');
  await assert.rejects(disabled.recheck(h.actor, h.result.order.id, request()), code('PAYMENTS_DISABLED'));
  const guest = randomUUID(); const quote = await h.service.createQuote(guest, input('simulated'));
  const simulated = await h.service.createOrder(guest, { quoteId: quote.id }, randomUUID());
  assert.equal((await h.checks.history(h.actor, simulated.order.id)).eligibility.reason, 'not_stripe');
  await assert.rejects(h.checks.recheck(h.actor, simulated.order.id, request()), code('PAYMENT_CHECK_NOT_ELIGIBLE'));
  assert.equal(h.retrieves.length, 0); assert.equal((await history(h)).events.length, 0);
});

test('request IDs bind actor and order and input rejects all client-supplied actor/status/amount fields', async () => {
  const h = await setup(); const another = await start(h); const body = request();
  for (const invalid of [null, {}, [], { requestId: 'bad' }, { ...body, actor: h.actor }, { ...body, paymentStatus: 'PAID' }, { ...body, totalCents: 1 }]) await assert.rejects(check(h, invalid), code('INVALID_REQUEST'));
  await check(h, body);
  await assert.rejects(h.checks.recheck(h.actor, another.result.order.id, body), code('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(h.checks.history({ userId: 'guest', role: 'guest' }, h.result.order.id), code('MERCHANT_FORBIDDEN'));
  const other = { userId: `merchant_${randomUUID()}`, role: 'merchant' };
  const result = await h.checks.recheck(other, another.result.order.id, body);
  assert.equal(result.replayed, false); assert.equal(result.check.actor.id, other.userId);
});

test('simultaneous same-key and different-key clicks make one provider call and expose a retry time', async () => {
  const entered = latch(); const release = latch();
  const h = await setup({ onRetrieve: async (session) => { entered.resolve(); await release.promise; return clone(session); } });
  const body = request(); const running = check(h, body); await entered.promise;
  const inflight = await history(h); assert.equal(inflight.eligibility.reason, 'in_progress');
  for (const next of [body, request()]) await assert.rejects(check(h, next), e => e.code === 'PAYMENT_CHECK_IN_PROGRESS' && new Date(e.retryAt) > h.currentTime());
  release.resolve(); await running;
  assert.equal(h.retrieves.length, 1); assert.equal((await history(h)).events.length, 2);
});

test('same request recovers expired crash lease once and late original worker is fenced', async () => {
  const firstEntered = latch(); const firstRelease = latch(); let calls = 0;
  const h = await setup({ onRetrieve: async session => { calls++; if (calls === 1) { firstEntered.resolve(); await firstRelease.promise; } return clone(session); } });
  const body = request(); const original = check(h, body); await firstEntered.promise;
  h.advance(30_001); const resumed = await check(h, body);
  firstRelease.resolve(); const stale = await original;
  assert.equal(resumed.check.outcome, 'pending'); assert.equal(stale.replayed, true); assert.equal(stale.check.id, resumed.check.id);
  assert.equal((await history(h)).events.length, 2); assert.equal(h.retrieves.length, 2);
});

test('new request after an abandoned lease records interrupted result without attributing provider failure', async () => {
  const h = await setup(); const abandoned = request();
  await h.checks.claim(h.actor, h.result.order.id, abandoned.requestId);
  h.advance(30_001); const result = await check(h);
  assert.equal(result.check.outcome, 'pending'); assert.equal(h.retrieves.length, 1);
  assert.deepEqual((await history(h)).events.map(e => e.outcome), ['pending','requested','interrupted','requested']);
  const replay = await check(h, abandoned); assert.equal(replay.replayed, true); assert.equal(replay.check.outcome, 'interrupted');
});

test('fencing token prevents stale worker update while replacement worker is still retrieving', async () => {
  const entered = [latch(), latch()]; const releases = [latch(), latch()]; let calls = 0;
  const h = await setup({ onRetrieve: async session => { const i = calls++; entered[i].resolve(); await releases[i].promise; return clone(session); } });
  const body = request(); const old = check(h, body); await entered[0].promise;
  h.advance(30_001); const replacement = check(h, body); await entered[1].promise;
  releases[0].resolve(); await assert.rejects(old, code('PAYMENT_CHECK_IN_PROGRESS'));
  assert.equal((await history(h)).events.length, 1);
  releases[1].resolve(); await replacement; assert.equal((await history(h)).events.length, 2);
});

test('concurrent webhook confirmation/cancellation is retained and audit observes the latest locked state', async () => {
  for (const resolution of ['paid','canceled']) {
    const entered = latch(); const release = latch(); let first = true;
    const h = await setup({ onRetrieve: async session => { if (first) { first = false; const old = clone(session); entered.resolve(); await release.promise; return old; } return clone(session); } });
    const running = check(h); await entered.promise;
    if (resolution === 'paid') paid(h.session); else { h.session.status='expired'; h.session.url=null; }
    const event = signed(h.session, resolution === 'paid' ? 'checkout.session.completed' : 'checkout.session.expired');
    await h.service.webhook(event.raw, event.signature); release.resolve(); const result = await running;
    assert.equal(result.check.outcome, 'already_resolved');
    assert.equal(result.check.previousPaymentStatus, resolution === 'paid' ? 'PAID' : 'CANCELED');
    assert.equal(result.order.paymentStatus, result.check.previousPaymentStatus);
  }
});

test('abandoned same-key retry after webhook resolution completes without another provider retrieval', async () => {
  const h = await setup(); const body = request(); await h.checks.claim(h.actor, h.result.order.id, body.requestId);
  paid(h.session); const event = signed(h.session); await h.service.webhook(event.raw,event.signature);
  h.advance(30_001); const result=await check(h,body);
  assert.equal(result.check.outcome,'already_resolved'); assert.equal(h.retrieves.length,1);
});

test('order cooldown is cross-merchant and actor limit is serialized across orders', async () => {
  const h = await setup(); await check(h);
  await assert.rejects(h.checks.recheck({userId:'other-merchant',role:'merchant'},h.result.order.id,request()), e=>e.code==='PAYMENT_CHECK_RATE_LIMITED'&&!!e.retryAt);
  for (let i=0;i<4;i++) { const next=await start(h); await h.checks.recheck(h.actor,next.result.order.id,request()); }
  const sixth=await start(h);
  assert.equal((await h.checks.history(h.actor,sixth.result.order.id)).eligibility.reason,'cooldown');
  await assert.rejects(h.checks.recheck(h.actor,sixth.result.order.id,request()),code('PAYMENT_CHECK_RATE_LIMITED'));
  h.advance(60_000); await h.checks.recheck(h.actor,sixth.result.order.id,request());
});

function wrappedPool(onQuery) {
  return { query: pool.query.bind(pool), async connect() { const client=await pool.connect(); return { release: (...args)=>client.release(...args), query: async (sql,args)=>onQuery(client,sql,args) }; } };
}
test('failure inserting the result audit rolls back payment update and remains recoverable with the same request', async () => {
  const h=await setup(); paid(h.session); const body=request();
  const faulty=wrappedPool(async(client,sql,args)=>{ if(sql.includes('INSERT INTO merchant_payment_check_events')&&args[7]!=='requested') throw new Error('audit insert failed'); return client.query(sql,args); });
  const checks=new MerchantPaymentChecks(faulty,{service:h.service,now:h.currentTime});
  await assert.rejects(checks.recheck(h.actor,h.result.order.id,body),/audit insert failed/);
  assert.equal((await h.service.readOrder(h.guest,h.result.order.id)).paymentStatus,'PENDING');
  assert.deepEqual((await history(h)).events.map(e=>e.outcome),['requested']);
  h.advance(30_001); const result=await check(h,body); assert.equal(result.order.paymentStatus,'PAID'); assert.equal((await history(h)).events.length,2);
});

test('lost commit acknowledgment is recovered by latest-order replay without an extra provider request', async()=>{
  const h=await setup(); const body=request(); let commits=0;
  const flaky=wrappedPool(async(client,sql,args)=>{ const result=await client.query(sql,args); if(sql==='COMMIT'&&++commits===2) throw new Error('response lost'); return result; });
  await assert.rejects(new MerchantPaymentChecks(flaky,{service:h.service,now:h.currentTime}).recheck(h.actor,h.result.order.id,body),/response lost/);
  const replay=await check(h,body); assert.equal(replay.replayed,true); assert.equal(h.retrieves.length,1); assert.equal((await history(h)).events.length,2);
});

test('history bounds latest twenty deterministic events and sanitizes immutable actor labels', async()=>{
  const h=await setup({name:'  Friendly\u0001 Merchant\u200b  '});
  for(let i=0;i<11;i++){ await check(h); h.advance(60_000); }
  const page=await history(h); assert.equal(page.events.length,20); assert.equal(page.hasMore,true); assert.equal(page.events[0].outcome,'pending');
  assert.ok(page.events.every(e=>e.actor.displayName==='Friendly Merchant'));
  await pool.query('DELETE FROM merchant_users WHERE id=$1',[h.actor.userId]);
  assert.deepEqual((await history(h)).events,page.events);
  const privateName=await setup({name:'private@fixture.test'}); assert.equal((await check(privateName)).check.actor.displayName,'Merchant');
});

test('unresolved expired orders retain audit; resolved order cleanup cascades attempts/events', async()=>{
  const h=await setup(); await check(h); const paidOrder=await setup(); paid(paidOrder.session); await check(paidOrder);
  const later=new Date(Date.now()+31*86400000); await cleanupExpired(pool,later);
  assert.equal((await pool.query('SELECT id FROM merchant_payment_check_events WHERE order_id=$1',[h.result.order.id])).rowCount,2);
  assert.equal((await pool.query('SELECT id FROM merchant_payment_check_events WHERE order_id=$1',[paidOrder.result.order.id])).rowCount,0);
  assert.equal((await pool.query('SELECT id FROM merchant_payment_check_attempts WHERE order_id=$1',[paidOrder.result.order.id])).rowCount,0);
});

test('HTTP requires a live merchant session and exact origin independently of service bearer, validates bodies, and never caches audit',async()=>{
  const h=await setup();
  const env={DATABASE_URL:process.env.DATABASE_URL,MERCHANT_AUTH_ENABLED:'true',MERCHANT_ALLOW_LOCAL_AUTH:'true',MERCHANT_TEST_FIXTURES:'true',MERCHANT_TEST_RUN_ID:randomUUID(),BETTER_AUTH_URL:'http://127.0.0.1:3100',BETTER_AUTH_SECRET:randomBytes(32).toString('hex'),GITHUB_CLIENT_ID:'fixture-client',GITHUB_CLIENT_SECRET:'fixture-client-secret-at-least-20',MERCHANT_GITHUB_IDS:'123456789'};
  const auth=createMerchantAuth({pool,env}); const sessions=await seedMerchantSessions({pool,env});
  const server=createServer(createHandler({service:h.service,merchantOrders:new MerchantOrders(pool),merchantPaymentChecks:h.checks,authorizeMerchant:auth.authorize,merchantAuth:()=>auth,secret:'service-secret-123456789-01234567890',logger:()=>{}}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); const base=`http://127.0.0.1:${server.address().port}/v1/merchant/orders/${h.result.order.id}`;
  const post=async(headers={},body=request())=>fetch(`${base}/recheck-payment`,{method:'POST',headers:{'content-type':'application/json',origin:auth.origin,cookie:sessions.merchant.cookie,...headers},body:JSON.stringify(body)});
  try{
    for(const cookie of ['',sessions.expiredCookie]) assert.equal((await post({cookie,authorization:'Bearer service-secret-123456789-01234567890','x-guest-id':h.guest})).status,401);
    assert.equal((await post({cookie:sessions.ordinary.cookie})).status,403);
    for(const headers of [{origin:''},{origin:'https://attacker.test'},{origin:auth.origin+'/'},{'sec-fetch-site':'cross-site'},{'sec-fetch-site':'same-site'}]) assert.equal((await post(headers)).status,403);
    assert.equal((await post({}, {requestId:randomUUID(),paymentStatus:'PAID'})).status,400);
    assert.equal((await post({'content-type':'text/plain'})).status,415);
    assert.equal((await post({}, {requestId:'x'.repeat(17000)})).status,413);
    const response=await post();assert.equal(response.status,200);assert.equal((await response.json()).check.outcome,'pending');assert.equal(response.headers.get('cache-control'),'private, no-store');
    const limited=await post();assert.equal(limited.status,429);assert.ok((await limited.json()).error.retryAt);
    const get=await fetch(`${base}/payment-checks`,{headers:{cookie:sessions.merchant.cookie}});assert.equal(get.status,200);assert.equal((await get.json()).events.length,2);
    assert.equal((await fetch(`${base}/payment-checks`,{headers:{authorization:'Bearer service-secret-123456789-01234567890'}})).status,401);
    assert.equal((await fetch(`${base}/recheck-payment`,{headers:{cookie:sessions.merchant.cookie}})).status,405);
  }finally{await new Promise(resolve=>server.close(resolve));}
});

test('first cancellation of an old unresolved order retains the receipt and audit for thirty days without replay extension',async()=>{
  const h=await setup();h.advance(31*86400000);h.session.status='expired';h.session.url=null;const body=request();
  const result=await check(h,body);const expected=new Date(h.currentTime().getTime()+30*86400000).toISOString();
  assert.equal(result.order.expiresAt,expected);assert.equal((await history(h)).events.length,2);
  await cleanupExpired(pool,h.currentTime());assert.equal((await history(h)).events.length,2);
  h.advance(86400000);assert.equal((await check(h,body)).order.expiresAt,expected);
  const event=signed(h.session,'checkout.session.expired');await h.service.webhook(event.raw,event.signature);
  assert.equal((await h.service.readOrder(h.guest,h.result.order.id)).expiresAt,expected);
});
