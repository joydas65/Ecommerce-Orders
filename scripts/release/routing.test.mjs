import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { convertRewrites } from '@vercel/routing-utils';

const config = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8'));

function assertRoutesToApi(pathnames) {
  const routes = convertRewrites(config.rewrites);
  for (const pathname of pathnames) {
    const route = routes.find(candidate => new RegExp(candidate.src).test(pathname));
    assert.ok(route, `The built routing rules must handle ${pathname}.`);
    const match = pathname.match(new RegExp(route.src));
    const destination = route.dest.replace(/\$(\d+)/g, (_, group) => match[Number(group)] || '');
    const target = new URL(destination, 'https://orders.example');
    assert.equal(target.pathname, '/api/index');
    assert.equal(target.search, '', `${pathname} must not acquire query parameters rejected by the API.`);
  }
}

test('Vercel compiles order routes without adding synthetic query parameters', () => {
  assertRoutesToApi(['/api/auth/sign-in/social', '/api/auth/callback/github', '/api/auth/sign-out', '/v1/merchant/session', '/v1/merchant/orders', '/v1/merchant/orders/order_example', '/v1/checkout-quotes', '/v1/orders', '/v1/orders/order_example', '/health', '/internal/cleanup']);
});

test('Vercel routes customer sign-in, callback, sign-out and account reads to the API', () => {
  assertRoutesToApi([
    '/api/customer-auth/ok',
    '/api/customer-auth/sign-in/social',
    '/api/customer-auth/callback/google',
    '/api/customer-auth/sign-out',
    '/v1/customer/session',
    '/v1/customer/orders',
    '/v1/customer/orders/order_example',
  ]);
});

test('Vercel lets the API deny unsupported customer authentication endpoints', () => {
  // The API allowlist owns these denials; the platform must still reach it.
  assertRoutesToApi([
    '/api/customer-auth/get-session',
    '/api/customer-auth/sign-up/email',
    '/api/customer-auth/link-social',
    '/api/customer-auth/callback/github',
  ]);
});

test('the former named wildcard reproduces the platform query injection', () => {
  const [route] = convertRewrites([{ source: '/v1/:path*', destination: '/api/index' }]);
  assert.match(route.dest, /[?&]path=/);
});
