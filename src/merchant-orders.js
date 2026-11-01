import { ApiError, missingOrder } from './errors.js';
import { isEntityId } from './validation.js';

export const merchantStatuses = Object.freeze(['all', 'paid', 'pending', 'canceled', 'review', 'simulated']);
const paymentStatuses = { paid: 'PAID', pending: 'PENDING', canceled: 'CANCELED', review: 'REQUIRES_REVIEW', simulated: 'SIMULATED' };
const invalidQuery = () => new ApiError(400, 'INVALID_MERCHANT_QUERY', 'Choose a valid payment filter and page.');
const retained = "(expires_at > $1 OR (payment_provider = 'stripe-test' AND receipt->>'status' IN ('PENDING_PAYMENT', 'PAYMENT_REVIEW')))";
const cursorTimestamp = `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

function readCursor(value, status) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalidQuery();
  let decoded;
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) throw invalidQuery();
    decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { throw invalidQuery(); }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded) || Object.keys(decoded).length !== 4
    || decoded.v !== 1 || decoded.status !== status || typeof decoded.at !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(decoded.at) || decoded.at.startsWith('0000-')
    || !isEntityId(decoded.id, 'order') || decoded.id !== decoded.id.toLowerCase()) throw invalidQuery();
  const date = new Date(decoded.at);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== decoded.at.replace(/(\.\d{3})\d{3}Z$/, '$1Z')) throw invalidQuery();
  return decoded;
}

export function merchantQuery(params = new URLSearchParams()) {
  if (!(params instanceof URLSearchParams)) throw invalidQuery();
  const keys = [...params.keys()];
  if (keys.some((key) => !['status', 'limit', 'cursor'].includes(key)) || new Set(keys).size !== keys.length) throw invalidQuery();
  const status = params.get('status') ?? 'all';
  const limit = params.get('limit') ?? '20';
  if (!merchantStatuses.includes(status) || !/^(?:[1-9]|[1-4][0-9]|50)$/.test(limit)) throw invalidQuery();
  return { status, limit: Number(limit), cursor: params.has('cursor') ? readCursor(params.get('cursor'), status) : null };
}

// Explicit field projection keeps guest identities, idempotency keys, provider
// session details and future internal receipt fields out of the merchant API.
export function merchantReceipt(row) {
  const r = row.receipt;
  return {
    id: r.id, reference: r.reference, quoteId: r.quoteId,
    createdAt: r.createdAt, expiresAt: r.expiresAt,
    status: r.status, paymentStatus: r.paymentStatus,
    paymentProvider: row.payment_provider,
    ...(row.payment_provider === 'stripe-test' ? { paymentMode: 'test' } : {}),
    currency: r.currency, pricingVersion: r.pricingVersion,
    shippingMethod: r.shippingMethod, subtotalCents: r.subtotalCents,
    shippingCents: r.shippingCents, taxCents: r.taxCents, totalCents: r.totalCents,
    items: r.items.map((item) => ({ productId: item.productId, name: item.name,
      quantity: item.quantity, unitPriceCents: item.unitPriceCents, lineTotalCents: item.lineTotalCents })),
  };
}

export function merchantSummary(row) {
  const r = row.receipt;
  return { id: r.id, reference: r.reference, createdAt: r.createdAt,
    status: r.status, paymentStatus: r.paymentStatus, paymentProvider: row.payment_provider,
    ...(row.payment_provider === 'stripe-test' ? { paymentMode: 'test' } : {}),
    totalCents: r.totalCents, currency: r.currency,
    itemCount: r.items.reduce((count, item) => count + item.quantity, 0) };
}

export class MerchantOrders {
  constructor(pool, { now = () => new Date() } = {}) {
    this.pool = pool;
    this.now = now;
  }

  async list(params) {
    const { status, limit, cursor } = merchantQuery(params);
    const values = [this.now()];
    const conditions = [retained];
    if (status !== 'all') {
      values.push(paymentStatuses[status]);
      conditions.push(`receipt->>'paymentStatus' = $${values.length}`);
    }
    if (cursor) {
      values.push(cursor.at, cursor.id);
      conditions.push(`(created_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::text)`);
    }
    values.push(limit + 1);
    const result = await this.pool.query(`SELECT receipt, payment_provider, ${cursorTimestamp} AS cursor_at, id
      FROM orders WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT $${values.length}`, values);
    const hasMore = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);
    const last = rows.at(-1);
    const nextCursor = hasMore ? Buffer.from(JSON.stringify({ v: 1, status, at: last.cursor_at, id: last.id })).toString('base64url') : null;
    // Pagination is a live keyset view: newly inserted newer orders appear on
    // refresh, without offset shifts or duplicates on subsequent pages.
    return { orders: rows.map(merchantSummary), pageInfo: { nextCursor, hasMore } };
  }

  async read(id) {
    if (!isEntityId(id, 'order')) throw missingOrder();
    const result = await this.pool.query(`SELECT receipt, payment_provider FROM orders WHERE ${retained} AND id = $2`, [this.now(), id.toLowerCase()]);
    if (!result.rowCount) throw missingOrder();
    return merchantReceipt(result.rows[0]);
  }
}
