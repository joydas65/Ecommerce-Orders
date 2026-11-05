import { ApiError, missingOrder } from './errors.js';
import { isEntityId } from './validation.js';
import { merchantQuery, merchantReceipt, merchantSummary } from './merchant-orders.js';

const retained = "(expires_at > $2 OR (payment_provider = 'stripe-test' AND receipt->>'status' IN ('PENDING_PAYMENT', 'PAYMENT_REVIEW')))";
const cursorTimestamp = `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const invalidQuery = () => new ApiError(400, 'INVALID_CUSTOMER_QUERY', 'Choose a valid order history page.');

function customerId(identity) {
  if (identity?.role !== 'customer' || typeof identity.userId !== 'string' || !identity.userId || identity.userId.length > 255) {
    throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in to view your orders.');
  }
  return identity.userId;
}

function query(params) {
  if (!(params instanceof URLSearchParams) || [...params.keys()].some((key) => !['limit', 'cursor'].includes(key))) throw invalidQuery();
  try { return merchantQuery(params); } catch { throw invalidQuery(); }
}

export class CustomerOrders {
  constructor(pool, { now = () => new Date() } = {}) { this.pool = pool; this.now = now; }

  async list(identity, params = new URLSearchParams()) {
    const userId = customerId(identity);
    const { limit, cursor } = query(params);
    const values = [userId, this.now()];
    const conditions = ['customer_user_id = $1', retained];
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
    const nextCursor = hasMore ? Buffer.from(JSON.stringify({ v: 1, status: 'all', at: last.cursor_at, id: last.id })).toString('base64url') : null;
    return { orders: rows.map(merchantSummary), pageInfo: { nextCursor, hasMore } };
  }

  async read(identity, id) {
    const userId = customerId(identity);
    if (!isEntityId(id, 'order')) throw missingOrder();
    const result = await this.pool.query(`SELECT receipt, payment_provider FROM orders WHERE customer_user_id = $1 AND ${retained} AND id = $3`, [userId, this.now(), id.toLowerCase()]);
    if (!result.rowCount) throw missingOrder();
    return merchantReceipt(result.rows[0]);
  }
}
