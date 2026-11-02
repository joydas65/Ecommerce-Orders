import { randomUUID } from 'node:crypto';
import { ApiError, invalid, missingOrder } from './errors.js';
import { transaction } from './database.js';
import { isEntityId, isUuid } from './validation.js';
import { merchantReceipt } from './merchant-orders.js';

const leaseMs = 30_000;
const orderCooldownMs = 10_000;
const actorWindowMs = 60_000;
const actorLimit = 5;
const unresolved = (row) => row.payment_provider === 'stripe-test' && ['PENDING_PAYMENT', 'PAYMENT_REVIEW'].includes(row.receipt.status);
const eligibleSession = (row) => /^cs_test_[A-Za-z0-9]+$/.test(row.stripe_session_id || '');
const notEligible = () => new ApiError(409, 'PAYMENT_CHECK_NOT_ELIGIBLE', 'This order cannot be rechecked. Refresh its payment history.');
const unavailable = () => new ApiError(503, 'PAYMENT_CHECK_UNAVAILABLE', 'The check result is not confirmed. Retry the same request.');
function retryError(status, code, message, at) {
  const error = new ApiError(status, code, message);
  error.retryAt = at.toISOString();
  return error;
}
const inProgress = (at) => retryError(409, 'PAYMENT_CHECK_IN_PROGRESS', 'A payment check is already running. Retry the same request after the indicated time.', at);
const limited = (at) => retryError(429, 'PAYMENT_CHECK_RATE_LIMITED', 'Wait before starting another payment check.', at);
const eventDTO = (row) => ({ id: row.id, requestId: row.request_id, actor: { id: row.actor_id, displayName: row.actor_label },
  occurredAt: row.occurred_at.toISOString(), outcome: row.outcome, previousPaymentStatus: row.previous_payment_status, resultPaymentStatus: row.result_payment_status });

function actorId(actor) {
  if (actor?.role !== 'merchant' || typeof actor.userId !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(actor.userId)) throw new ApiError(403, 'MERCHANT_FORBIDDEN', 'Merchant access is required.');
  return actor.userId;
}
function safeLabel(value) {
  if (typeof value !== 'string') return 'Merchant';
  const normalized = value.normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim();
  if (!normalized || normalized.includes('@')) return 'Merchant';
  let label = '';
  for (const character of normalized) { if ((label + character).length > 80) break; label += character; }
  return label || 'Merchant';
}

export class MerchantPaymentChecks {
  constructor(pool, { service, now = () => new Date() } = {}) {
    this.pool = pool;
    this.service = service;
    this.now = now;
  }

  async order(client, id, lock = false) {
    if (!isEntityId(id, 'order')) throw missingOrder();
    // Lock the order first everywhere, matching the provider transition's lock
    // order. The order row also fences cleanup and concurrent webhook updates.
    const result = await client.query(`SELECT o.receipt, o.payment_provider, p.stripe_session_id FROM orders o
      LEFT JOIN payment_sessions p ON p.order_id = o.id WHERE o.id = $1 AND
      (o.expires_at > $2 OR (o.payment_provider = 'stripe-test' AND o.receipt->>'status' IN ('PENDING_PAYMENT','PAYMENT_REVIEW')))
      ${lock ? 'FOR UPDATE OF o' : ''}`, [id.toLowerCase(), this.now()]);
    if (!result.rowCount) throw missingOrder();
    return result.rows[0];
  }

  async history(actor, id) {
    const merchant = actorId(actor);
    const row = await this.order(this.pool, id);
    let reason = !this.service?.stripe ? 'payments_disabled' : row.payment_provider !== 'stripe-test' ? 'not_stripe'
      : !unresolved(row) ? 'resolved' : !eligibleSession(row) ? 'missing_session' : 'ready';
    let retryAt = null;
    if (reason === 'ready') {
      const active = (await this.pool.query('SELECT lease_expires_at FROM merchant_payment_check_attempts WHERE order_id = $1 AND completed_at IS NULL AND lease_expires_at > $2', [row.receipt.id, this.now()])).rows[0];
      if (active) { reason = 'in_progress'; retryAt = active.lease_expires_at.toISOString(); }
      else {
        const until = await this.rateLimitUntil(this.pool, merchant, row.receipt.id);
        if (until) { reason = 'cooldown'; retryAt = until.toISOString(); }
      }
    }
    const rows = (await this.pool.query('SELECT * FROM merchant_payment_check_events WHERE order_id = $1 ORDER BY sequence DESC LIMIT 21', [row.receipt.id])).rows;
    return { eligibility: { eligible: reason === 'ready', reason, retryAt }, events: rows.slice(0, 20).map(eventDTO), hasMore: rows.length > 20 };
  }

  async rateLimitUntil(client, merchant, id) {
    const now = this.now();
    const recent = (await client.query('SELECT requested_at FROM merchant_payment_check_attempts WHERE actor_id = $1 AND requested_at > $2 ORDER BY requested_at DESC LIMIT $3', [merchant, new Date(now.getTime() - actorWindowMs), actorLimit])).rows;
    const last = (await client.query('SELECT requested_at FROM merchant_payment_check_attempts WHERE order_id = $1 ORDER BY requested_at DESC LIMIT 1', [id])).rows[0];
    const until = Math.max(recent.length === actorLimit ? recent.at(-1).requested_at.getTime() + actorWindowMs : 0,
      last ? last.requested_at.getTime() + orderCooldownMs : 0);
    return until > now.getTime() ? new Date(until) : null;
  }

  async record(client, attempt, previous, resulting, outcome) {
    const event = { id: randomUUID(), request_id: attempt.request_id, actor_id: attempt.actor_id, actor_label: attempt.actor_label,
      occurred_at: this.now(), outcome, previous_payment_status: previous, result_payment_status: resulting };
    await client.query(`INSERT INTO merchant_payment_check_events
      (id,attempt_id,order_id,request_id,actor_id,actor_label,occurred_at,outcome,previous_payment_status,result_payment_status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [event.id, attempt.id, attempt.order_id, event.request_id, event.actor_id, event.actor_label,
      event.occurred_at, outcome, previous, resulting]);
    if (outcome !== 'requested') await client.query('UPDATE merchant_payment_check_attempts SET completed_at = $2, result_event_id = $3 WHERE id = $1', [attempt.id, event.occurred_at, event.id]);
    return eventDTO(event);
  }

  async replay(client, attempt, row) {
    const event = (await client.query('SELECT * FROM merchant_payment_check_events WHERE id = $1', [attempt.result_event_id])).rows[0];
    if (!event) throw unavailable();
    return { order: merchantReceipt(row), check: eventDTO(event), replayed: true };
  }

  async claim(actor, id, requestId) {
    const merchant = actorId(actor);
    return transaction(this.pool, async (client) => {
      // All claim transactions lock actor then order. Completion only needs the
      // order lock, so rate limiting cannot introduce a reversed lock cycle.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`payment-check-actor:${merchant}`]);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`payment-check-order:${id}`]);
      const prior = (await client.query('SELECT * FROM merchant_payment_check_attempts WHERE actor_id = $1 AND request_id = $2', [merchant, requestId])).rows[0];
      if (prior && prior.order_id !== id) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This request belongs to another order.');
      const row = await this.order(client, id, true);
      if (prior?.completed_at) return { response: await this.replay(client, prior, row) };
      const now = this.now();
      const active = (await client.query('SELECT * FROM merchant_payment_check_attempts WHERE order_id = $1 AND completed_at IS NULL FOR UPDATE', [id])).rows[0];
      if (active && active.lease_expires_at > now) throw inProgress(active.lease_expires_at);
      if (active && active.id !== prior?.id) await this.record(client, active, row.receipt.paymentStatus, row.receipt.paymentStatus, 'interrupted');
      if (prior) {
        if (!unresolved(row)) return { response: { order: merchantReceipt(row), check: await this.record(client, prior, row.receipt.paymentStatus, row.receipt.paymentStatus, 'already_resolved'), replayed: false } };
        if (!this.service?.stripe || !eligibleSession(row) || prior.session_id !== row.stripe_session_id) {
          return { response: { order: merchantReceipt(row), check: await this.record(client, prior, row.receipt.paymentStatus, row.receipt.paymentStatus, 'interrupted'), replayed: false } };
        }
        const lease = randomUUID();
        const leaseExpires = new Date(now.getTime() + leaseMs);
        await client.query('UPDATE merchant_payment_check_attempts SET lease_token=$2,lease_expires_at=$3 WHERE id=$1', [prior.id, lease, leaseExpires]);
        return { attempt: { ...prior, lease_token: lease, lease_expires_at: leaseExpires } };
      }
      if (!this.service?.stripe) throw new ApiError(503, 'PAYMENTS_DISABLED', 'Stripe test payment checks are unavailable.');
      if (!unresolved(row) || !eligibleSession(row)) throw notEligible();
      const until = await this.rateLimitUntil(client, merchant, id);
      if (until) throw limited(until);
      const name = (await client.query('SELECT name FROM merchant_users WHERE id = $1', [merchant])).rows[0]?.name;
      const attempt = { id: randomUUID(), actor_id: merchant, actor_label: safeLabel(name), request_id: requestId, order_id: id,
        session_id: row.stripe_session_id, requested_at: now, lease_token: randomUUID(), lease_expires_at: new Date(now.getTime() + leaseMs) };
      await client.query(`INSERT INTO merchant_payment_check_attempts
        (id,actor_id,actor_label,request_id,order_id,session_id,requested_at,lease_token,lease_expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [attempt.id, merchant, attempt.actor_label, requestId, id, attempt.session_id, now, attempt.lease_token, attempt.lease_expires_at]);
      await this.record(client, attempt, row.receipt.paymentStatus, row.receipt.paymentStatus, 'requested');
      return { attempt };
    });
  }

  async recheck(actor, id, input) {
    actorId(actor);
    if (!isEntityId(id, 'order')) throw missingOrder();
    id = id.toLowerCase();
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 || !isUuid(input.requestId)) throw invalid();
    const claimed = await this.claim(actor, id, input.requestId.toLowerCase());
    if (claimed.response) return claimed.response;
    const attempt = claimed.attempt;
    let session;
    let providerFailed = false;
    // Retrieval only: this path never calls ensureSession, create, or expire.
    // Provider calls happen outside transactions; a process crash leaves a
    // bounded durable lease that the same request can recover after expiry.
    try { session = await this.service.stripe.retrieve(attempt.session_id); }
    catch { providerFailed = true; }
    return transaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`payment-check-order:${id}`]);
      const row = await this.order(client, id, true);
      const current = (await client.query('SELECT * FROM merchant_payment_check_attempts WHERE id = $1 FOR UPDATE', [attempt.id])).rows[0];
      if (!current) throw unavailable();
      if (current.completed_at) return this.replay(client, current, row);
      if (current.lease_token !== attempt.lease_token) throw inProgress(current.lease_expires_at);
      const previous = row.receipt.paymentStatus;
      let outcome;
      let result = row.receipt;
      if (!unresolved(row)) outcome = 'already_resolved';
      else if (providerFailed) outcome = 'provider_unavailable';
      else if (row.stripe_session_id !== attempt.session_id) outcome = 'interrupted';
      else {
        result = (await this.service.applyRetrievedSession(client, session, attempt.session_id, id)).order;
        outcome = { PAID: 'paid', PENDING: 'pending', CANCELED: 'canceled', REQUIRES_REVIEW: 'review_required' }[result.paymentStatus];
      }
      const check = await this.record(client, current, previous, result.paymentStatus, outcome);
      return { order: merchantReceipt({ ...row, receipt: result }), check, replayed: false };
    });
  }
}
