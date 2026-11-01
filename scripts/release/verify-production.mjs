import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export function validateOrigin(value, expectedHost, allowLocal = false) {
  const url = new URL(value);
  if (!expectedHost || url.hostname !== expectedHost || url.username || url.password
      || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Verify the expected orders hostname and supply its origin only.');
  }
  const local = allowLocal && ['127.0.0.1', 'localhost'].includes(url.hostname);
  if ((!local && (url.protocol !== 'https:' || url.port)) || (local && url.protocol !== 'http:')) {
    throw new Error('Orders checks require HTTPS; only explicit loopback testing may use HTTP.');
  }
  return url.origin;
}

export async function smokeOrders({ baseUrl, secret, fetchImpl = fetch }) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('A server-only orders API secret is required.');
  const guest = randomUUID();
  const key = randomUUID();
  async function request(method, path, body, owner = guest, authenticate = true, idempotencyKey) {
    const headers = { 'content-type': 'application/json', 'x-guest-id': owner };
    if (authenticate) headers.authorization = `Bearer ${secret}`;
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    const response = await fetchImpl(baseUrl + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error', signal: AbortSignal.timeout(20_000),
    });
    let payload;
    try { payload = await response.json(); } catch { throw new Error('Orders API did not return JSON.'); }
    return { status: response.status, payload };
  }
  const input = { items: [{ productId: 'demo-desk-mat', quantity: 1 }],
    shippingMethod: 'demo-standard', destination: { country: 'US', region: 'CA' } };
  assert.equal((await request('POST', '/v1/checkout-quotes', input, guest, false)).status, 401,
    'Unauthenticated order API access must fail.');
  const quote = await request('POST', '/v1/checkout-quotes', input);
  assert.equal(quote.status, 201, 'Quote creation must succeed.');
  assert.equal(quote.payload.totalCents, 4212, 'The server must calculate the full total.');
  assert.equal(quote.payload.shippingCents, 500, 'Shipping must be included.');
  const orderInput = { quoteId: quote.payload.id };
  const created = await request('POST', '/v1/orders', orderInput, guest, true, key);
  assert.equal(created.status, 201, 'An order is confirmed only after persistence.');
  assert.equal(created.payload.status, 'CONFIRMED');
  assert.equal(created.payload.paymentStatus, 'SIMULATED');
  assert.equal(created.payload.totalCents, 4212);
  const replay = await request('POST', '/v1/orders', orderInput, guest, true, key);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.payload, created.payload, 'A retry must return the original receipt.');
  const receipt = await request('GET', `/v1/orders/${created.payload.id}`);
  assert.equal(receipt.status, 200);
  assert.deepEqual(receipt.payload, created.payload, 'A fresh read must load the saved receipt.');
  assert.equal((await request('GET', `/v1/orders/${created.payload.id}`, undefined, randomUUID())).status, 404,
    'Another guest must not read the receipt.');
  assert.equal((await request('POST', '/v1/checkout-quotes', { ...input, totalCents: 1 })).status, 400,
    'Client prices must be rejected.');
  return { checks: 7, orderId: created.payload.id };
}

async function main() {
  const baseUrl = validateOrigin(process.env.ORDERS_API_URL, process.env.EXPECTED_ORDERS_HOST,
    process.env.ORDERS_ALLOW_LOCAL_API === 'true' && !process.env.VERCEL);
  await smokeOrders({ baseUrl, secret: process.env.ORDERS_API_SECRET });
  console.log('Orders smoke passed: authentication, shipping, persistence, replay, reload, guest isolation and price validation.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    // Responses, credentials and guest IDs must never enter deployment logs.
    console.error('Orders smoke failed. Check configuration and sanitized service logs; no credentials or payloads were printed.');
    process.exitCode = 1;
  });
}
