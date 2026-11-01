import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { convertRewrites } from '@vercel/routing-utils';

const config = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8'));

test('Vercel compiles order routes without adding synthetic query parameters', () => {
  const routes = convertRewrites(config.rewrites);
  for (const pathname of ['/api/auth/sign-in/social', '/api/auth/callback/github', '/api/auth/sign-out', '/v1/merchant/session', '/v1/merchant/orders', '/v1/merchant/orders/order_example', '/v1/checkout-quotes', '/v1/orders', '/v1/orders/order_example', '/health', '/internal/cleanup']) {
    const route = routes.find(candidate => new RegExp(candidate.src).test(pathname));
    assert.ok(route, `The built routing rules must handle ${pathname}.`);
    const match = pathname.match(new RegExp(route.src));
    const destination = route.dest.replace(/\$(\d+)/g, (_, group) => match[Number(group)] || '');
    const target = new URL(destination, 'https://orders.example');
    assert.equal(target.pathname, '/api/index');
    assert.equal(target.search, '', `${pathname} must not acquire query parameters rejected by the API.`);
  }
});

test('the former named wildcard reproduces the platform query injection', () => {
  const [route] = convertRewrites([{ source: '/v1/:path*', destination: '/api/index' }]);
  assert.match(route.dest, /[?&]path=/);
});
