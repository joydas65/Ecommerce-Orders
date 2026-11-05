import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { ApiError, invalid } from './errors.js';

export const maxBodyBytes = 16384;
export const maxWebhookBytes = 262144;
const digest = (value) => createHash('sha256').update(value).digest();

export function validApiSecret(secret) {
  return typeof secret === 'string' && secret.length >= 32 && secret.length <= 256 && /^[\x21-\x7e]+$/.test(secret);
}

function authorized(header, secret) {
  if (!validApiSecret(secret)) throw new Error('Orders service authentication is not configured.');
  if (typeof header !== 'string' || header.length > 512) return false;
  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}

async function rawBody(request, limit = maxBodyBytes) {
  const type = request.headers['content-type'];
  if (typeof type !== 'string' || type.split(';')[0].trim().toLowerCase() !== 'application/json') throw new ApiError(415, 'JSON_REQUIRED', 'Send a JSON request.');
  const size = Number(request.headers['content-length']);
  if (Number.isFinite(size) && size > limit) throw new ApiError(413, 'REQUEST_TOO_LARGE', 'The request is too large.');
  const body = await new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let rejected = false;
    request.on('data', (chunk) => {
      if (rejected) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > limit) {
        rejected = true;
        reject(new ApiError(413, 'REQUEST_TOO_LARGE', 'The request is too large.'));
        // Keep draining without retaining bytes so the 413 can reach the caller.
        return;
      }
      chunks.push(buffer);
    });
    request.once('end', () => resolve(Buffer.concat(chunks)));
    request.once('error', reject);
    request.once('aborted', () => reject(invalid()));
  });
  return body;
}

async function jsonBody(request) {
  const body = await rawBody(request);
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
  catch { throw invalid(); }
}

function send(response, status, body, requestId) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'X-Request-Id': requestId });
  response.end(JSON.stringify(body));
}

// Native IncomingMessage/ServerResponse API shared by Vercel and local HTTP.
export function createHandler({ service, secret, cronSecret, cleanup, merchantOrders, merchantPaymentChecks, authorizeMerchant, merchantAuth, customerOrders, authorizeCustomer, customerAuth, logger = console.info }) {
  return async function handler(request, response) {
    const started = performance.now();
    const requestId = randomUUID();
    let status = 500;
    try {
      const url = new URL(request.url, 'http://orders.internal');
      const path = url.pathname;
      if (request.method === 'GET' && path === '/health') {
        status = 200;
        return send(response, status, { status: 'ok' }, requestId);
      }
      if (request.method === 'GET' && path === '/internal/cleanup') {
        if (cronSecret === secret) throw new Error('Cleanup requires a distinct secret.');
        if (!authorized(request.headers.authorization, cronSecret)) throw new ApiError(401, 'UNAUTHORIZED', 'Service authentication is required.');
        if (url.search) throw invalid();
        const counts = await cleanup();
        status = 200;
        return send(response, status, counts, requestId);
      }
      if (request.method === 'POST' && path === '/v1/webhooks/stripe') {
        if (url.search) throw invalid();
        const result = await service.webhook(await rawBody(request, maxWebhookBytes), request.headers['stripe-signature']);
        status = 200;
        return send(response, status, result, requestId);
      }
      const customerAuthPath = path === '/api/customer-auth' || path.startsWith('/api/customer-auth/');
      if (customerAuthPath || path === '/api/auth' || path.startsWith('/api/auth/')) {
        const prefix = customerAuthPath ? '/api/customer-auth' : '/api/auth';
        const endpoint = path.slice(prefix.length + 1);
        const methods = Object.fromEntries(Object.entries({ ok: 'GET', 'callback/google': 'GET', 'sign-in/social': 'POST', 'sign-out': 'POST',
          ...(!customerAuthPath ? { 'callback/github': 'GET', 'link-social': 'POST' } : {}) }).map(([name, method]) => [`${prefix}/${name}`, method]));
        if (!Object.hasOwn(methods, path)) throw new ApiError(404, 'NOT_FOUND', 'This endpoint is unavailable.');
        if (request.method !== methods[path]) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'This authentication method is unavailable.');
        const factory = customerAuthPath ? customerAuth : merchantAuth;
        const authUnavailable = () => new ApiError(503, customerAuthPath ? 'CUSTOMER_UNAVAILABLE' : 'MERCHANT_UNAVAILABLE', 'Sign-in is temporarily unavailable.');
        if (typeof factory !== 'function') throw authUnavailable();
        const auth = factory();
        if (!auth?.origin || typeof auth.handler !== 'function') throw authUnavailable();
        const providers = customerAuthPath ? ['google'] : auth.enabledProviders || ['github'];
        if (endpoint.startsWith('callback/') && !providers.includes(endpoint.slice('callback/'.length))) throw new ApiError(404, 'NOT_FOUND', 'This endpoint is unavailable.');
        if (request.url.length > 8192 || (!endpoint.startsWith('callback/') && url.search)) throw invalid();
        let body;
        if (request.method === 'POST') {
          if (request.headers.origin !== auth.origin || ['cross-site', 'same-site'].includes(request.headers['sec-fetch-site'])) throw new ApiError(403, 'AUTH_ORIGIN_INVALID', 'Open sign-in from the storefront.');
          const input = await jsonBody(request);
          if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid();
          if (endpoint === 'sign-in/social' || endpoint === 'link-social') {
            if (Object.keys(input).sort().join(',') !== 'callbackURL,errorCallbackURL,provider'
              || !providers.includes(input.provider) || input.callbackURL !== (customerAuthPath ? '/account' : '/admin/orders')
              || input.errorCallbackURL !== (customerAuthPath ? '/account/sign-in' : '/admin/sign-in')) throw invalid();
            if (endpoint === 'link-social') {
              if (input.provider !== 'google' || typeof auth.authorize !== 'function') throw invalid();
              const merchant = await auth.authorize(request);
              if (merchant?.role !== 'merchant') throw new ApiError(403, 'MERCHANT_FORBIDDEN', 'Merchant access is required.');
            }
          } else if (Object.keys(input).length) throw invalid();
          body = JSON.stringify(input);
        }
        const headers = new Headers();
        for (const name of ['cookie', 'origin', 'content-type', 'sec-fetch-site', 'user-agent', 'x-forwarded-for']) {
          if (typeof request.headers[name] === 'string') headers.set(name, request.headers[name]);
        }
        const result = await auth.handler(new Request(new URL(request.url, auth.origin), { method: request.method, headers, ...(body === undefined ? {} : { body }) }));
        status = result.status;
        response.statusCode = status;
        response.setHeader('Cache-Control', 'private, no-store');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('X-Request-Id', requestId);
        for (const name of ['content-type', 'location']) {
          const value = result.headers.get(name);
          if (value) response.setHeader(name, value);
        }
        const cookies = result.headers.getSetCookie();
        if (cookies.length) response.setHeader('Set-Cookie', cookies);
        response.end(Buffer.from(await result.arrayBuffer()));
        return;
      }
      if (path === '/v1/merchant' || path.startsWith('/v1/merchant/')) {
        if (!merchantOrders || typeof authorizeMerchant !== 'function') throw new ApiError(503, 'MERCHANT_UNAVAILABLE', 'Merchant orders are temporarily unavailable.');
        const identity = await authorizeMerchant(request);
        if (typeof identity?.userId !== 'string' || !identity.userId) throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in to view merchant orders.');
        if (identity.role !== 'merchant') throw new ApiError(403, 'MERCHANT_FORBIDDEN', 'Merchant access is required.');
        const action = path.match(/^\/v1\/merchant\/orders\/([^/]+)\/(payment-checks|recheck-payment)$/);
        if (action) {
          const requiredMethod = action[2] === 'payment-checks' ? 'GET' : 'POST';
          if (request.method !== requiredMethod) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'This payment check method is unavailable.');
          if (url.search) throw invalid();
          if (!merchantPaymentChecks) throw new ApiError(503, 'MERCHANT_UNAVAILABLE', 'Payment checks are temporarily unavailable.');
          if (requiredMethod === 'POST') {
            const origin = typeof merchantAuth === 'function' ? merchantAuth()?.origin : null;
            if (!origin || request.headers.origin !== origin || ['cross-site', 'same-site'].includes(request.headers['sec-fetch-site'])) {
              throw new ApiError(403, 'AUTH_ORIGIN_INVALID', 'Open payment checks from the storefront.');
            }
          }
          const result = requiredMethod === 'GET' ? await merchantPaymentChecks.history(identity, action[1])
            : await merchantPaymentChecks.recheck(identity, action[1], await jsonBody(request));
          status = 200;
          return send(response, status, result, requestId);
        }
        if (request.method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'This merchant method is unavailable.');
        let result;
        if (path === '/v1/merchant/session') {
          if (url.search) throw invalid();
          result = { user: { id: identity.userId }, role: 'merchant' };
          const auth = typeof merchantAuth === 'function' ? merchantAuth() : null;
          if (typeof auth?.accountStatus === 'function') result.authentication = { providers: auth.enabledProviders, ...await auth.accountStatus(request) };
        } else if (path === '/v1/merchant/orders') result = await merchantOrders.list(url.searchParams);
        else if (path.startsWith('/v1/merchant/orders/')) {
          if (url.search) throw new ApiError(400, 'INVALID_MERCHANT_QUERY', 'Choose a valid payment filter and page.');
          result = await merchantOrders.read(path.slice('/v1/merchant/orders/'.length));
        } else throw new ApiError(404, 'NOT_FOUND', 'This endpoint is unavailable.');
        status = 200;
        return send(response, status, result, requestId);
      }
      if (path === '/v1/customer' || path.startsWith('/v1/customer/')) {
        if (!customerOrders || typeof authorizeCustomer !== 'function') throw new ApiError(503, 'CUSTOMER_UNAVAILABLE', 'Your account is temporarily unavailable.');
        const identity = await authorizeCustomer(request);
        if (typeof identity?.userId !== 'string' || !identity.userId || identity.role !== 'customer') throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in to view your orders.');
        if (request.method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'This account operation is unavailable.');
        let result;
        if (path === '/v1/customer/session') {
          if (url.search) throw invalid();
          result = { user: { id: identity.userId, displayName: identity.displayName }, role: 'customer' };
        } else if (path === '/v1/customer/orders') result = await customerOrders.list(identity, url.searchParams);
        else if (/^\/v1\/customer\/orders\/[^/]+$/.test(path)) {
          if (url.search) throw invalid();
          result = await customerOrders.read(identity, path.slice('/v1/customer/orders/'.length));
        } else throw new ApiError(404, 'NOT_FOUND', 'This endpoint is unavailable.');
        status = 200;
        return send(response, status, result, requestId);
      }
      if (!authorized(request.headers.authorization, secret)) throw new ApiError(401, 'UNAUTHORIZED', 'Service authentication is required.');
      if (url.search) throw invalid();
      const guest = request.headers['x-guest-id'];
      let customerId = null;
      // Only a verified shopper session may set ownership. Client-supplied IDs,
      // roles, guest cookies and the service bearer cannot grant account access.
      if (request.method === 'POST' && ['/v1/orders', '/v1/payment-sessions'].includes(path)
        && /(?:^|;\s*)(?:__Secure-)?joys_customer\.session_token=/.test(request.headers.cookie || '')) {
        if (typeof authorizeCustomer !== 'function') throw new ApiError(503, 'CUSTOMER_UNAVAILABLE', 'Your account is temporarily unavailable.');
        const identity = await authorizeCustomer(request);
        if (identity?.role !== 'customer' || typeof identity.userId !== 'string' || !identity.userId) throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in again before submitting this checkout.');
        customerId = identity.userId;
      }
      if (request.method === 'POST' && path === '/v1/checkout-quotes') {
        const quote = await service.createQuote(guest, await jsonBody(request));
        status = 201;
        send(response, status, quote, requestId);
      } else if (request.method === 'POST' && path === '/v1/orders') {
        const result = await service.createOrder(guest, await jsonBody(request), request.headers['idempotency-key'], customerId);
        status = result.replayed ? 200 : 201;
        send(response, status, result.order, requestId);
      } else if (request.method === 'POST' && path === '/v1/payment-sessions') {
        const result = await service.createPaymentSession(guest, await jsonBody(request), request.headers['idempotency-key'], customerId);
        status = result.replayed ? 200 : 201;
        send(response, status, { order: result.order, checkoutUrl: result.checkoutUrl }, requestId);
      } else if (request.method === 'POST' && /^\/v1\/orders\/[^/]+\/(reconcile|cancel)$/.test(path)) {
        const body = await jsonBody(request);
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw invalid();
        const [, , , id, action] = path.split('/');
        const result = await (action === 'cancel' ? service.cancelOrder(guest, id) : service.reconcileOrder(guest, id));
        status = 200;
        send(response, status, result, requestId);
      } else if (request.method === 'GET' && path.startsWith('/v1/orders/')) {
        const order = await service.readOrder(guest, path.slice('/v1/orders/'.length));
        status = 200;
        send(response, status, order, requestId);
      } else {
        throw new ApiError(404, 'NOT_FOUND', 'This endpoint is unavailable.');
      }
    } catch (error) {
      status = error instanceof ApiError ? error.status : 503;
      const code = error instanceof ApiError ? error.code : 'SERVICE_UNAVAILABLE';
      const message = error instanceof ApiError ? error.message : 'Orders are temporarily unavailable. Please retry with the same submission key.';
      if (!response.headersSent) send(response, status, { error: { code, message, ...(error instanceof ApiError && typeof error.retryAt === 'string' ? { retryAt: error.retryAt } : {}) } }, requestId);
    } finally {
      // Deliberately omit URLs, headers, SQL, input, receipt and error messages.
      try {
        logger(JSON.stringify({ event: 'orders_request', requestId, status, durationMs: Math.round(performance.now() - started) }));
      } catch { /* A logging failure must not change a committed response. */ }
    }
  };
}
