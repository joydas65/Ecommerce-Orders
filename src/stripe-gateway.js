import Stripe from 'stripe';

export const stripeApiVersion = '2026-10-28.endive';
export const stripeEvents = new Set(['checkout.session.completed', 'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed', 'checkout.session.expired']);

export function storefrontOrigin(env) {
  const url = new URL(env.STOREFRONT_ORIGIN || 'invalid:');
  const local = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)
    && env.ORDERS_ALLOW_LOCAL_STOREFRONT === 'true' && !env.VERCEL;
  if ((!local && url.protocol !== 'https:') || !url.hostname || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) throw new Error('Storefront origin is not configured.');
  return url.origin;
}

export function stripeGatewayFromEnv(env = process.env) {
  if (env.STRIPE_PAYMENTS_ENABLED !== 'true') return null;
  if (!/^sk_test_[A-Za-z0-9]+$/.test(env.STRIPE_SECRET_KEY || '')
    || !/^whsec_[A-Za-z0-9]+$/.test(env.STRIPE_WEBHOOK_SECRET || '')) throw new Error('Stripe test credentials are required.');
  return createStripeGateway({ stripeClient: new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: stripeApiVersion, timeout: 4000, maxNetworkRetries: 0, telemetry: false,
  }), storefrontOrigin: storefrontOrigin(env), webhookSecret: env.STRIPE_WEBHOOK_SECRET });
}

export function createStripeGateway({ stripeClient, storefrontOrigin: origin, webhookSecret }) {
  return {
    params(order) {
      const product = (name, cents, quantity) => ({ quantity, price_data: { currency: 'usd', unit_amount: cents, product_data: { name } } });
      return {
        mode: 'payment', allowed_payment_method_types: ['card'], adaptive_pricing: { enabled: false },
        automatic_tax: { enabled: false }, allow_promotion_codes: false,
        client_reference_id: order.id, metadata: { orderId: order.id },
        payment_intent_data: { metadata: { orderId: order.id } },
        line_items: [...order.items.map((item) => product(item.name, item.unitPriceCents, item.quantity)),
          product('Sample tax (8%, test only)', order.taxCents, 1)],
        shipping_options: [{ shipping_rate_data: { type: 'fixed_amount', display_name: order.shippingMethod === 'demo-standard' ? 'Standard shipping (test)' : 'Express shipping (test)', fixed_amount: { amount: order.shippingCents, currency: 'usd' } } }],
        success_url: `${origin}/orders/${order.id}?checkout=return`,
        cancel_url: `${origin}/orders/${order.id}?checkout=cancel`,
      };
    },
    create: (params, key) => stripeClient.checkout.sessions.create(params, { idempotencyKey: key }),
    retrieve: (id) => stripeClient.checkout.sessions.retrieve(id, { expand: ['line_items'] }),
    expire: (id, key) => stripeClient.checkout.sessions.expire(id, {}, { idempotencyKey: key }),
    verifyEvent: (body, signature) => stripeClient.webhooks.constructEvent(body, signature, webhookSecret),
  };
}

export function checkoutUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'checkout.stripe.com' && !url.port
      && !url.username && !url.password ? value : null;
  } catch { return null; }
}

// A redirect or Session creation response never proves payment. A fresh
// server-side retrieval must pass this validator before storing confirmation.
export function verifiedSession(session, order, { requireItems = true } = {}) {
  if (!session || !/^cs_test_[A-Za-z0-9]+$/.test(session.id || '') || session.livemode !== false
    || session.mode !== 'payment' || session.currency !== 'usd' || session.amount_total !== order.totalCents
    || session.metadata?.orderId !== order.id || session.client_reference_id !== order.id
    || !['open', 'complete', 'expired'].includes(session.status)
    || !['paid', 'unpaid'].includes(session.payment_status)
    || !Number.isSafeInteger(session.expires_at) || session.expires_at <= 0
    || (session.payment_status === 'paid' && session.status !== 'complete')) return false;
  if (session.status === 'open' && !checkoutUrl(session.url)) return false;
  const intent = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
  if (intent != null && !/^pi_[A-Za-z0-9]+$/.test(intent)) return false;
  if (session.payment_status === 'paid' && !intent) return false;
  if (!requireItems) return true;
  if (session.total_details?.amount_shipping !== order.shippingCents || session.total_details?.amount_tax !== 0
    || session.total_details?.amount_discount !== 0 || session.line_items?.has_more !== false
    || !Array.isArray(session.line_items.data)) return false;
  const expected = [...order.items.map((item) => ({ name: item.name, cents: item.unitPriceCents, quantity: item.quantity })),
    { name: 'Sample tax (8%, test only)', cents: order.taxCents, quantity: 1 }];
  const actual = [...session.line_items.data];
  if (actual.length !== expected.length) return false;
  for (const item of expected) {
    const index = actual.findIndex((line) => line.description === item.name && line.quantity === item.quantity
      && line.currency === 'usd' && line.price?.currency === 'usd' && line.price.unit_amount === item.cents
      && line.amount_subtotal === item.cents * item.quantity && line.amount_total === item.cents * item.quantity);
    if (index < 0) return false;
    actual.splice(index, 1);
  }
  return true;
}
