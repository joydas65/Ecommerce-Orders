import test from 'node:test';
import assert from 'node:assert/strict';
import { smokeOrders, validateOrigin } from './verify-production.mjs';

const origin = 'https://joys-orders.vercel.app';
const secret = 'test-only-secret-that-is-at-least-32-characters';
const order = { id: 'order_example', status: 'CONFIRMED', paymentStatus: 'SIMULATED', totalCents: 4212 };
const fixture = () => [[401, {}], [201, { id: 'quote_example', totalCents: 4212, shippingCents: 500 }],
  [201, order], [200, order], [200, order], [404, {}], [400, {}]];

test('credentials can only be sent to the explicitly verified HTTPS origin', () => {
  assert.equal(validateOrigin(origin, 'joys-orders.vercel.app'), origin);
  for (const value of ['http://joys-orders.vercel.app', 'https://other.vercel.app',
    `${origin}:8443`, `${origin}/orders`, `${origin}?token=example`, `${origin}#fragment`,
    'https://user:password@joys-orders.vercel.app']) {
    assert.throws(() => validateOrigin(value, 'joys-orders.vercel.app'));
  }
  assert.throws(() => validateOrigin(origin, ''));
});

test('local HTTP is opt-in and loopback-only', () => {
  assert.throws(() => validateOrigin('http://127.0.0.1:4100', '127.0.0.1'));
  assert.equal(validateOrigin('http://127.0.0.1:4100', '127.0.0.1', true), 'http://127.0.0.1:4100');
  assert.throws(() => validateOrigin('http://example.com', 'example.com', true));
});

test('full smoke verifies durable replay, guest separation and suppresses redirects', async () => {
  const replies = fixture();
  const requests = [];
  const result = await smokeOrders({ baseUrl: origin, secret, fetchImpl: async (url, options) => {
    requests.push({ url, ...options });
    const [status, payload] = replies.shift();
    return Response.json(payload, { status });
  } });
  assert.deepEqual(result, { checks: 7, orderId: order.id });
  assert.equal(requests[0].headers.authorization, undefined);
  assert.equal(requests[1].headers.authorization, `Bearer ${secret}`);
  assert.equal(requests[2].headers['idempotency-key'], requests[3].headers['idempotency-key']);
  assert.notEqual(requests[4].headers['x-guest-id'], requests[5].headers['x-guest-id']);
  assert.ok(requests.every(request => request.redirect === 'error'));
});

for (const [name, index, response] of [
  ['public unauthenticated API', 0, [201, {}]],
  ['missing shipping', 1, [201, { totalCents: 4212, shippingCents: 0 }]],
  ['failed persistence', 2, [503, {}]],
  ['duplicate receipt', 3, [200, { ...order, id: 'duplicate' }]],
  ['lost receipt', 4, [404, {}]],
  ['guest data leak', 5, [200, order]],
  ['client price accepted', 6, [201, {}]],
]) {
  test(`release check rejects ${name}`, async () => {
    const replies = fixture();
    replies[index] = response;
    await assert.rejects(smokeOrders({ baseUrl: origin, secret, fetchImpl: async () => {
      const [status, payload] = replies.shift();
      return Response.json(payload, { status });
    } }));
  });
}

test('missing credentials fail before any network request', async () => {
  let calls = 0;
  await assert.rejects(smokeOrders({ baseUrl: origin, secret: '', fetchImpl: () => { calls++; } }));
  assert.equal(calls, 0);
});

test('unexpected deployment-protection HTML fails safely', async () => {
  await assert.rejects(smokeOrders({ baseUrl: origin, secret,
    fetchImpl: async () => new Response('<html>Sign in</html>') }), /did not return JSON/);
});
