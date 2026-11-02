import { createHandler } from './api.js';
import { createPool } from './database.js';
import { OrderService } from './service.js';
import { cleanupExpired } from './cleanup.js';
import { stripeGatewayFromEnv } from './stripe-gateway.js';
import { MerchantPaymentChecks } from './merchant-payment-checks.js';
import { MerchantOrders } from './merchant-orders.js';
import { createMerchantAuth } from './merchant-auth.js';
import { ApiError } from './errors.js';

let runtime;
export function runtimeHandler(request, response) {
  // Initialize lazily so an unhealthy configuration fails closed with a safe
  // response instead of exposing an initialization exception or environment.
  if (!runtime) {
    try {
      const pool = createPool();
      let auth;
      const merchantAuth = () => {
        try {
          auth ||= createMerchantAuth({ pool });
          if (!auth) throw new Error('Merchant authentication disabled.');
          return auth;
        } catch { throw new ApiError(503, 'MERCHANT_UNAVAILABLE', 'Merchant sign-in is temporarily unavailable.'); }
      };
      const service = new OrderService(pool, { stripeGateway: stripeGatewayFromEnv() });
      runtime = createHandler({ service, merchantPaymentChecks: new MerchantPaymentChecks(pool, { service }), merchantOrders: new MerchantOrders(pool), merchantAuth, authorizeMerchant: (request) => merchantAuth().authorize(request), secret: process.env.ORDERS_API_SECRET, cronSecret: process.env.CRON_SECRET, cleanup: () => cleanupExpired(pool) });
    } catch {
      response.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' });
      response.end(JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Orders are temporarily unavailable.' } }));
      return;
    }
  }
  return runtime(request, response);
}
