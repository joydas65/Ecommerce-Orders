import pg from 'pg';

export function databaseConfig(env = process.env) {
  const url = new URL(env.DATABASE_URL || 'invalid:');
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname.slice(1)) throw new Error('Database configuration is required.');
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (local && env.VERCEL) throw new Error('A remote database is required on Vercel.');
  // Always verify remote TLS certificates. URL sslmode settings must not silently
  // replace the explicit pg SSL object with a weaker configuration.
  url.search = '';
  return {
    connectionString: url.toString(),
    ssl: local ? false : { rejectUnauthorized: true },
    enableChannelBinding: !local,
    max: 4,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 8000,
    statement_timeout: 8000,
    application_name: 'joys-store-orders',
  };
}

export function createPool(env = process.env) {
  const pool = new pg.Pool(databaseConfig(env));
  // An idle connection failure must not crash a warm serverless instance or log
  // a connection string, query, guest identity, or submitted document.
  pool.on('error', () => console.error(JSON.stringify({ event: 'database_connection_error' })));
  return pool;
}

export async function transaction(pool, action) {
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '4s'");
    const value = await action(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { discard = true; }
    throw error;
  } finally {
    client.release(discard);
  }
}
