import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { betterAuth } from 'better-auth';
import { makeSignature } from 'better-auth/crypto';
import { createPool } from '../../src/database.js';
import { merchantAuthConfiguration, merchantAuthOptions } from '../../src/merchant-auth.js';

// Local integration fixture only. No endpoint calls this file, and a remote
// database or Vercel runtime is always refused, even if the opt-in is set.
export async function seedMerchantSessions({ pool, env = process.env }) {
  const database = new URL(env.DATABASE_URL || 'invalid:');
  if (env.VERCEL || env.MERCHANT_TEST_FIXTURES !== 'true'
    || !['localhost', '127.0.0.1', '[::1]'].includes(database.hostname)) throw new Error('Merchant fixtures require explicit opt-in and disposable loopback PostgreSQL.');
  const config = merchantAuthConfiguration(env);
  if (!config || config.secure || !['localhost', '127.0.0.1'].includes(new URL(config.origin).hostname)) throw new Error('Merchant fixtures require local authentication.');
  const runId = env.MERCHANT_TEST_RUN_ID;
  if (runId !== undefined && !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(runId)) throw new Error('Merchant fixture run ID must be a UUID.');
  const suffix = runId ? `_${runId.toLowerCase()}` : '';
  const auth = betterAuth(merchantAuthOptions(pool, config));
  const context = await auth.$context;
  async function seed(kind, githubId, expiresAt) {
    const userId = `local_fixture_${kind}${suffix}`;
    // A GitHub account can belong to only one fixture identity. Remove only
    // identities created by this loopback-only helper; audit actor IDs have no
    // user foreign key and remain attached to their retained orders.
    const existing = (await pool.query('SELECT "userId" FROM merchant_accounts WHERE "providerId" = $1 AND "accountId" = $2', ['github', githubId])).rows;
    for (const account of existing) {
      if (!/^local_fixture_(merchant|ordinary)(_[a-f0-9-]{36})?$/.test(account.userId)) throw new Error('Refusing to replace a non-fixture merchant account.');
      await pool.query('DELETE FROM merchant_users WHERE id = $1', [account.userId]);
    }
    await pool.query('DELETE FROM merchant_users WHERE id = $1', [userId]);
    await pool.query('INSERT INTO merchant_users (id, name, email, "emailVerified") VALUES ($1, $2, $3, true)', [userId, `Local ${kind}`, `${kind}${suffix}@merchant-fixture.test`]);
    await pool.query('INSERT INTO merchant_accounts (id, "accountId", "providerId", "userId", "updatedAt") VALUES ($1, $2, $3, $4, now())', [randomUUID(), githubId, 'github', userId]);
    const session = await context.internalAdapter.createSession(userId);
    if (expiresAt) await pool.query('UPDATE merchant_sessions SET "expiresAt" = $1 WHERE id = $2', [expiresAt, session.id]);
    const cookie = `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${await makeSignature(session.token, config.secret)}`)}`;
    return { userId, cookie, sessionId: session.id };
  }
  const allowed = [...config.githubIds][0];
  const merchant = await seed('merchant', allowed);
  const ordinaryId = config.githubIds.has('9999999999999999999') ? '9999999999999999998' : '9999999999999999999';
  const ordinary = await seed('ordinary', ordinaryId);
  const expired = await context.internalAdapter.createSession(merchant.userId);
  await pool.query('UPDATE merchant_sessions SET "expiresAt" = $1 WHERE id = $2', [new Date(Date.now() - 60_000), expired.id]);
  const expiredCookie = `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${expired.token}.${await makeSignature(expired.token, config.secret)}`)}`;
  return { merchant, ordinary, expiredCookie };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = process.argv[2];
  if (!output) throw new Error('Pass an output file for local cookie fixtures.');
  const pool = createPool();
  try {
    const fixtures = await seedMerchantSessions({ pool });
    writeFileSync(output, JSON.stringify(fixtures), { mode: 0o600 });
    console.info('Local merchant session fixtures written.');
  } finally { await pool.end(); }
}
