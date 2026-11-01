import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createPool, transaction } from './database.js';

export async function cleanupExpired(pool, now = new Date()) {
  return transaction(pool, async (client) => {
    const orders = await client.query('DELETE FROM orders WHERE expires_at <= $1', [now]);
    // Cascading deletes remove replay records. Keep consumed quotes while their
    // receipt is live; remove unconsumed expired quotes and old receipt quotes.
    const candidates = await client.query('SELECT id FROM checkout_quotes WHERE expires_at <= $1 FOR UPDATE SKIP LOCKED', [now]);
    const quotes = await client.query('DELETE FROM checkout_quotes q WHERE q.id = ANY($1::text[]) AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.quote_id = q.id)', [candidates.rows.map((row) => row.id)]);
    return { orders: orders.rowCount, quotes: quotes.rowCount };
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pool = createPool();
  try { const counts = await cleanupExpired(pool); console.info(JSON.stringify({ event: 'orders_retention_cleanup', ...counts })); }
  catch { console.error('Orders retention cleanup failed.'); process.exitCode = 1; }
  finally { await pool.end(); }
}
