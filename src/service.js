import { createHash, randomUUID } from 'node:crypto';
import { ApiError, missingOrder } from './errors.js';
import { transaction } from './database.js';
import { guestIdentity, isEntityId, quoteInput, submissionInput } from './validation.js';

const quoteLifetime = 15 * 60 * 1000;
const orderLifetime = 30 * 24 * 60 * 60 * 1000;

export class OrderService {
  constructor(pool, { now = () => new Date() } = {}) {
    this.pool = pool;
    this.now = now;
  }

  async createQuote(guest, input) {
    guest = guestIdentity(guest);
    const pricing = quoteInput(input);
    const now = this.now();
    const quote = { id: `quote_${randomUUID()}`, expiresAt: new Date(now.getTime() + quoteLifetime).toISOString(), ...pricing };
    await this.pool.query('INSERT INTO checkout_quotes (id, guest_id, snapshot, expires_at, created_at) VALUES ($1, $2, $3, $4, $5)', [quote.id, guest, quote, quote.expiresAt, now]);
    return quote;
  }

  async createOrder(guest, input, idempotencyKey) {
    guest = guestIdentity(guest);
    const { quoteId, key } = submissionInput(input, idempotencyKey);
    const fingerprint = createHash('sha256').update(quoteId).digest('hex');
    return transaction(this.pool, async (client) => {
      // Transaction-scoped advisory locks work through Neon's transaction pooler.
      // The key lock serializes retries even when they target different quotes.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${guest}:${key}`]);
      const prior = await client.query('SELECT s.fingerprint, s.expires_at, o.receipt FROM order_submissions s JOIN orders o ON o.id = s.order_id WHERE s.guest_id = $1 AND s.idempotency_key = $2', [guest, key]);
      let now = this.now();
      if (prior.rows[0]) {
        if (prior.rows[0].fingerprint !== fingerprint) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This submission key belongs to another checkout.');
        if (prior.rows[0].expires_at <= now) throw new ApiError(410, 'SUBMISSION_EXPIRED', 'This receipt has expired.');
        return { order: prior.rows[0].receipt, replayed: true };
      }
      // Row locking serializes different submission keys for the same quote.
      // The UNIQUE orders.quote_id constraint also enforces this invariant.
      const found = await client.query('SELECT snapshot, expires_at FROM checkout_quotes WHERE id = $1 AND guest_id = $2 FOR UPDATE', [quoteId, guest]);
      const quote = found.rows[0];
      if (!quote) throw new ApiError(404, 'QUOTE_NOT_FOUND', 'This checkout quote is unavailable.');
      now = this.now();
      const consumed = await client.query('SELECT id FROM orders WHERE quote_id = $1', [quoteId]);
      if (consumed.rowCount) throw new ApiError(409, 'QUOTE_CONSUMED', 'This checkout quote has already been submitted.');
      if (quote.expires_at <= now) throw new ApiError(410, 'QUOTE_EXPIRED', 'Refresh your checkout quote before submitting.');
      const { id: ignoredId, expiresAt: ignoredExpiry, ...pricing } = quote.snapshot;
      const id = randomUUID();
      const order = { id: `order_${id}`, reference: `DEMO-${id.toUpperCase()}`, quoteId, status: 'CONFIRMED', paymentStatus: 'SIMULATED', createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + orderLifetime).toISOString(), ...pricing };
      await client.query('INSERT INTO orders (id, quote_id, guest_id, receipt, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6)', [order.id, quoteId, guest, order, order.expiresAt, now]);
      await client.query('INSERT INTO order_submissions (guest_id, idempotency_key, fingerprint, order_id, expires_at) VALUES ($1, $2, $3, $4, $5)', [guest, key, fingerprint, order.id, order.expiresAt]);
      return { order, replayed: false };
    });
  }

  async readOrder(guest, id) {
    guest = guestIdentity(guest);
    if (!isEntityId(id, 'order')) throw missingOrder();
    const result = await this.pool.query('SELECT receipt FROM orders WHERE id = $1 AND guest_id = $2 AND expires_at > $3', [id.toLowerCase(), guest, this.now()]);
    if (!result.rowCount) throw missingOrder();
    return result.rows[0].receipt;
  }
}
