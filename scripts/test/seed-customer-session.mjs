import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { betterAuth } from 'better-auth';
import { makeSignature } from 'better-auth/crypto';
import { createPool } from '../../src/database.js';
import { customerAuthConfiguration, customerAuthOptions } from '../../src/customer-auth.js';

// Only local browser/integration tests import this helper. No runtime endpoint does.
export async function seedCustomerSessions({ pool, env = process.env }) {
  const database = new URL(env.DATABASE_URL || 'invalid:');
  if (env.VERCEL || env.CUSTOMER_TEST_FIXTURES !== 'true'
    || !['localhost', '127.0.0.1', '[::1]'].includes(database.hostname)) throw new Error('Customer fixtures require explicit opt-in and disposable loopback PostgreSQL.');
  const config = customerAuthConfiguration(env);
  if (!config || config.secure || !['localhost', '127.0.0.1'].includes(new URL(config.origin).hostname)) throw new Error('Customer fixtures require local authentication.');
  const auth = betterAuth(customerAuthOptions(pool, config));
  const context = await auth.$context;
  async function cookie(session) {
    return `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${await makeSignature(session.token, config.secret)}`)}`;
  }
  async function seed(kind) {
    const userId = `local_customer_${kind}_${randomUUID()}`;
    await pool.query('INSERT INTO customer_users (id, name, email, "emailVerified") VALUES ($1, $2, $3, true)', [userId, `Local ${kind}`, `${userId}@customer-fixture.test`]);
    await pool.query('INSERT INTO customer_accounts (id, "accountId", "providerId", "userId", "updatedAt") VALUES ($1, $2, $3, $4, now())', [randomUUID(), `google-${randomUUID()}`, 'google', userId]);
    const session = await context.internalAdapter.createSession(userId);
    return { userId, cookie: await cookie(session), sessionId: session.id };
  }
  const customer = await seed('customer');
  const other = await seed('other');
  const expired = await context.internalAdapter.createSession(customer.userId);
  await pool.query('UPDATE customer_sessions SET "expiresAt" = $1 WHERE id = $2', [new Date(Date.now() - 60_000), expired.id]);
  return { customer, other, expiredCookie: await cookie(expired) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = process.argv[2];
  if (!output) throw new Error('Pass an output file for local cookie fixtures.');
  const pool = createPool();
  try {
    const fixtures = await seedCustomerSessions({ pool });
    writeFileSync(output, JSON.stringify(fixtures), { mode: 0o600 });
    console.info('Local customer session fixtures written.');
  } finally { await pool.end(); }
}
