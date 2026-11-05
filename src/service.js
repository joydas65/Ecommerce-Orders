import { createHash, randomUUID } from 'node:crypto';
import { ApiError, invalid, missingOrder } from './errors.js';
import { transaction } from './database.js';
import { guestIdentity, isEntityId, quoteInput, submissionInput } from './validation.js';
import { checkoutUrl, stripeEvents, verifiedSession } from './stripe-gateway.js';

const quoteLifetime = 15 * 60 * 1000;
const orderLifetime = 30 * 24 * 60 * 60 * 1000;
const creationRetryWindow = 23 * 60 * 60 * 1000;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const unavailable = () => new ApiError(503, 'PAYMENT_UNAVAILABLE', 'Payment could not be confirmed. Retry the same saved checkout.');
const providerMismatch = () => new ApiError(409, 'PAYMENT_PROVIDER_MISMATCH', 'This checkout belongs to a different payment provider.');

export class OrderService {
  constructor(pool, { now = () => new Date(), stripeGateway = null } = {}) {
    this.pool = pool;
    this.now = now;
    this.stripe = stripeGateway;
  }

  requireStripe() {
    if (!this.stripe) throw new ApiError(503, 'PAYMENTS_DISABLED', 'Stripe test payments are unavailable.');
  }

  async createQuote(guest, input) {
    guest = guestIdentity(guest);
    const pricing = quoteInput(input);
    if (pricing.paymentProvider === 'stripe-test') this.requireStripe();
    const now = this.now();
    const quote = { id: `quote_${randomUUID()}`, expiresAt: new Date(now.getTime() + quoteLifetime).toISOString(), ...pricing };
    await this.pool.query('INSERT INTO checkout_quotes (id, guest_id, snapshot, expires_at, created_at, payment_provider) VALUES ($1, $2, $3, $4, $5, $6)', [quote.id, guest, quote, quote.expiresAt, now, pricing.paymentProvider]);
    return quote;
  }

  async reserveOrder(guest, input, idempotencyKey, provider, customerId = null) {
    if (customerId !== null && (typeof customerId !== 'string' || !customerId || customerId.length > 255)) throw invalid();
    guest = guestIdentity(guest);
    const { quoteId, key } = submissionInput(input, idempotencyKey);
    const fingerprint = hash(`${provider}:${quoteId}`);
    return transaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${guest}:${key}`]);
      const prior = await client.query('SELECT s.fingerprint, s.expires_at, o.receipt, o.payment_provider, o.customer_user_id FROM order_submissions s JOIN orders o ON o.id = s.order_id WHERE s.guest_id = $1 AND s.idempotency_key = $2', [guest, key]);
      let now = this.now();
      if (prior.rows[0]) {
        const previous = prior.rows[0];
        // An idempotency replay cannot attach or transfer an existing order.
        // The same shopper identity must finish the submission it began.
        if (previous.customer_user_id !== customerId) throw new ApiError(409, 'CUSTOMER_CHECKOUT_CHANGED', 'Sign in with the account that started this checkout, or return to guest checkout to recover it.');
        if (previous.payment_provider !== provider) throw providerMismatch();
        const compatibleLegacy = provider === 'simulated' && previous.fingerprint === hash(quoteId);
        if (previous.fingerprint !== fingerprint && !compatibleLegacy) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This submission key belongs to another checkout.');
        if (previous.expires_at <= now && !['PENDING_PAYMENT', 'PAYMENT_REVIEW'].includes(previous.receipt.status)) throw new ApiError(410, 'SUBMISSION_EXPIRED', 'This receipt has expired.');
        return { order: previous.receipt, replayed: true };
      }
      const found = await client.query('SELECT snapshot, expires_at, payment_provider FROM checkout_quotes WHERE id = $1 AND guest_id = $2 FOR UPDATE', [quoteId, guest]);
      const quote = found.rows[0];
      if (!quote) throw new ApiError(404, 'QUOTE_NOT_FOUND', 'This checkout quote is unavailable.');
      if (quote.payment_provider !== provider) throw providerMismatch();
      now = this.now();
      const consumed = await client.query('SELECT id FROM orders WHERE quote_id = $1', [quoteId]);
      if (consumed.rowCount) throw new ApiError(409, 'QUOTE_CONSUMED', 'This checkout quote has already been submitted.');
      if (quote.expires_at <= now) throw new ApiError(410, 'QUOTE_EXPIRED', 'Refresh your checkout quote before submitting.');
      const { id: ignoredId, expiresAt: ignoredExpiry, ...pricing } = quote.snapshot;
      const id = randomUUID();
      const stripe = provider === 'stripe-test';
      const order = { ...pricing, id: `order_${id}`, reference: `${stripe ? 'TEST' : 'DEMO'}-${id.toUpperCase()}`, quoteId,
        status: stripe ? 'PENDING_PAYMENT' : 'CONFIRMED', paymentStatus: stripe ? 'PENDING' : 'SIMULATED',
        createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + orderLifetime).toISOString(), paymentProvider: provider,
        ...(stripe ? { paymentMode: 'test' } : {}) };
      await client.query('INSERT INTO orders (id, quote_id, guest_id, receipt, expires_at, created_at, payment_provider, customer_user_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [order.id, quoteId, guest, order, order.expiresAt, now, provider, customerId]);
      await client.query('INSERT INTO order_submissions (guest_id, idempotency_key, fingerprint, order_id, expires_at) VALUES ($1, $2, $3, $4, $5)', [guest, key, fingerprint, order.id, order.expiresAt]);
      if (stripe) await client.query('INSERT INTO payment_sessions (order_id, create_key, create_params, first_attempt_at) VALUES ($1, $2, $3, $4)',
        [order.id, `checkout:${order.id}`, this.stripe.params(order), now]);
      return { order, replayed: false };
    });
  }

  createOrder(guest, input, key, customerId = null) { return this.reserveOrder(guest, input, key, 'simulated', customerId); }

  async readOrder(guest, id) {
    guest = guestIdentity(guest);
    if (!isEntityId(id, 'order')) throw missingOrder();
    const result = await this.pool.query("SELECT receipt FROM orders WHERE id = $1 AND guest_id = $2 AND (expires_at > $3 OR (payment_provider = 'stripe-test' AND receipt->>'status' IN ('PENDING_PAYMENT', 'PAYMENT_REVIEW')))", [id.toLowerCase(), guest, this.now()]);
    if (!result.rowCount) throw missingOrder();
    return result.rows[0].receipt;
  }

  async createPaymentSession(guest, input, key, customerId = null) {
    this.requireStripe();
    const reserved = await this.reserveOrder(guest, input, key, 'stripe-test', customerId);
    return { ...await this.ensureSession(reserved.order.id), replayed: reserved.replayed };
  }

  async paymentRow(id) {
    const result = await this.pool.query('SELECT o.receipt, p.* FROM orders o JOIN payment_sessions p ON p.order_id = o.id WHERE o.id = $1', [id]);
    if (!result.rowCount) throw missingOrder();
    return result.rows[0];
  }

  async markReview(id) {
    return transaction(this.pool, async (client) => {
      const { rows } = await client.query('SELECT receipt FROM orders WHERE id = $1 FOR UPDATE', [id]);
      if (!rows[0]) throw missingOrder();
      let order = rows[0].receipt;
      if (!['CONFIRMED', 'CANCELED'].includes(order.status)) {
        order = { ...order, status: 'PAYMENT_REVIEW', paymentStatus: 'REQUIRES_REVIEW' };
        await client.query('UPDATE orders SET receipt = $2 WHERE id = $1', [id, order]);
      }
      return { order, checkoutUrl: null };
    });
  }

  async ensureSession(id) {
    const row = await this.paymentRow(id);
    if (['CONFIRMED', 'CANCELED'].includes(row.receipt.status)) return { order: row.receipt, checkoutUrl: null };
    if (row.stripe_session_id) return this.retrieveAndApply(row.stripe_session_id, id);
    if (row.receipt.status === 'PAYMENT_REVIEW' || this.now() - row.first_attempt_at >= creationRetryWindow) return this.markReview(id);
    let session;
    try { session = await this.stripe.create(row.create_params, row.create_key); }
    catch { throw unavailable(); }
    if (!verifiedSession(session, row.receipt, { requireItems: false })) return this.markReview(id);
    return transaction(this.pool, async (client) => {
      const current = (await client.query('SELECT o.receipt, p.stripe_session_id FROM orders o JOIN payment_sessions p ON p.order_id = o.id WHERE o.id = $1 FOR UPDATE OF o, p', [id])).rows[0];
      if (current.stripe_session_id && current.stripe_session_id !== session.id) throw unavailable();
      await client.query('UPDATE payment_sessions SET stripe_session_id = $2, session_expires_at = $3 WHERE order_id = $1', [id, session.id, new Date(session.expires_at * 1000)]);
      // A cached creation response claiming paid does not confirm an order.
      // A webhook or subsequent fresh retrieval must verify the payment.
      return { order: current.receipt, checkoutUrl: current.receipt.status === 'PENDING_PAYMENT' && session.status === 'open' ? checkoutUrl(session.url) : null };
    });
  }

  async reconcileOrder(guest, id) {
    this.requireStripe();
    const order = await this.readOrder(guest, id);
    if (order.paymentProvider !== 'stripe-test') throw providerMismatch();
    return this.ensureSession(order.id);
  }

  async cancelOrder(guest, id) {
    const current = await this.reconcileOrder(guest, id);
    if (['CONFIRMED', 'CANCELED', 'PAYMENT_REVIEW'].includes(current.order.status)) return current;
    const row = await this.paymentRow(current.order.id);
    if (!row.stripe_session_id) return this.markReview(current.order.id);
    try { await this.stripe.expire(row.stripe_session_id, `cancel:${current.order.id}`); }
    catch { /* A concurrent payment can win; retrieve the actual provider state. */ }
    return this.retrieveAndApply(row.stripe_session_id, current.order.id);
  }

  async retrieveAndApply(sessionId, orderId, event = null) {
    let session;
    try { session = await this.stripe.retrieve(sessionId); }
    catch { throw unavailable(); }
    return transaction(this.pool, (client) => this.applyRetrievedSession(client, session, sessionId, orderId, event));
  }

  // Caller owns the transaction. Merchant audit completion shares this exact
  // verified state transition with signed webhooks and shopper reconciliation.
  async applyRetrievedSession(client, session, sessionId, orderId, event = null) {
    const current = (await client.query('SELECT o.receipt, p.stripe_session_id, p.payment_intent_id FROM orders o JOIN payment_sessions p ON p.order_id = o.id WHERE o.id = $1 FOR UPDATE OF o, p', [orderId])).rows[0];
    if (!current) throw missingOrder();
    let order = current.receipt;
    if (event && (await client.query('SELECT event_id FROM stripe_events WHERE event_id = $1', [event.id])).rowCount) return { order, checkoutUrl: null };
    const intentId = typeof session?.payment_intent === 'string' ? session.payment_intent : session?.payment_intent?.id ?? null;
    const valid = session?.id === sessionId && (!current.stripe_session_id || current.stripe_session_id === sessionId)
      && (!current.payment_intent_id || current.payment_intent_id === intentId) && verifiedSession(session, order);
    if (order.status !== 'CONFIRMED') {
      if (!valid) {
        if (order.status !== 'CANCELED') order = { ...order, status: 'PAYMENT_REVIEW', paymentStatus: 'REQUIRES_REVIEW' };
      } else {
        await client.query('UPDATE payment_sessions SET stripe_session_id = $2, payment_intent_id = $3, session_expires_at = $4 WHERE order_id = $1', [orderId, sessionId, intentId, new Date(session.expires_at * 1000)]);
        if (session.payment_status === 'paid') {
          order = { ...order, status: 'CONFIRMED', paymentStatus: 'PAID', expiresAt: new Date(this.now().getTime() + orderLifetime).toISOString() };
        } else if (session.status === 'expired' && order.status !== 'CANCELED') order = { ...order, status: 'CANCELED', paymentStatus: 'CANCELED', expiresAt: new Date(this.now().getTime() + orderLifetime).toISOString() };
        else if (order.status !== 'CANCELED' && (event?.type === 'checkout.session.async_payment_failed' || order.status === 'PAYMENT_REVIEW')) order = { ...order, status: 'PAYMENT_REVIEW', paymentStatus: 'REQUIRES_REVIEW' };
      }
      await client.query('UPDATE orders SET receipt = $2, expires_at = $3 WHERE id = $1', [orderId, order, order.expiresAt]);
      await client.query('UPDATE order_submissions SET expires_at = $2 WHERE order_id = $1', [orderId, order.expiresAt]);
    }
    if (event) await client.query('INSERT INTO stripe_events (event_id, order_id, session_id, event_type) VALUES ($1, $2, $3, $4) ON CONFLICT (event_id) DO NOTHING', [event.id, orderId, sessionId, event.type]);
    return { order, checkoutUrl: valid && order.status === 'PENDING_PAYMENT' && session.status === 'open' ? checkoutUrl(session.url) : null };
  }

  async webhook(raw, signature) {
    this.requireStripe();
    let event;
    try { event = this.stripe.verifyEvent(raw, signature); }
    catch { throw new ApiError(400, 'INVALID_WEBHOOK', 'Webhook signature verification failed.'); }
    if (event.livemode !== false) throw new ApiError(400, 'INVALID_WEBHOOK', 'Only Stripe test events are accepted.');
    if (!stripeEvents.has(event.type)) return { received: true };
    if (!/^evt_[A-Za-z0-9]+$/.test(event.id || '') || !/^cs_test_[A-Za-z0-9]+$/.test(event.data?.object?.id || '')) throw invalid();
    const sessionId = event.data.object.id;
    const orderId = event.data.object.metadata?.orderId;
    if (!isEntityId(orderId, 'order')) return { received: true };
    const found = await this.pool.query('SELECT id FROM orders WHERE id = $1 AND payment_provider = $2', [orderId, 'stripe-test']);
    if (!found.rowCount) return { received: true };
    await this.retrieveAndApply(sessionId, orderId, event);
    return { received: true };
  }
}
