import { createHandler } from './api.js';
import { createPool } from './database.js';
import { OrderService } from './service.js';
import { cleanupExpired } from './cleanup.js';

let runtime;
export function runtimeHandler(request, response) {
  // Initialize lazily so an unhealthy configuration fails closed with a safe
  // response instead of exposing an initialization exception or environment.
  if (!runtime) {
    try {
      const pool = createPool();
      runtime = createHandler({ service: new OrderService(pool), secret: process.env.ORDERS_API_SECRET, cronSecret: process.env.CRON_SECRET, cleanup: () => cleanupExpired(pool) });
    } catch {
      response.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' });
      response.end(JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Orders are temporarily unavailable.' } }));
      return;
    }
  }
  return runtime(request, response);
}
