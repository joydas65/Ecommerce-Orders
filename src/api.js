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
export function createHandler({ service, secret, cronSecret, cleanup, logger = console.info }) {
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
      if (!authorized(request.headers.authorization, secret)) throw new ApiError(401, 'UNAUTHORIZED', 'Service authentication is required.');
      if (url.search) throw invalid();
      const guest = request.headers['x-guest-id'];
      if (request.method === 'POST' && path === '/v1/checkout-quotes') {
        const quote = await service.createQuote(guest, await jsonBody(request));
        status = 201;
        send(response, status, quote, requestId);
      } else if (request.method === 'POST' && path === '/v1/orders') {
        const result = await service.createOrder(guest, await jsonBody(request), request.headers['idempotency-key']);
        status = result.replayed ? 200 : 201;
        send(response, status, result.order, requestId);
      } else if (request.method === 'POST' && path === '/v1/payment-sessions') {
        const result = await service.createPaymentSession(guest, await jsonBody(request), request.headers['idempotency-key']);
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
      if (!response.headersSent) send(response, status, { error: { code, message } }, requestId);
    } finally {
      // Deliberately omit URLs, headers, SQL, input, receipt and error messages.
      try {
        logger(JSON.stringify({ event: 'orders_request', requestId, status, durationMs: Math.round(performance.now() - started) }));
      } catch { /* A logging failure must not change a committed response. */ }
    }
  };
}
