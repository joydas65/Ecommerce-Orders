import { betterAuth } from 'better-auth';
import { fromNodeHeaders } from 'better-auth/node';
import { ApiError } from './errors.js';

const unavailable = () => new ApiError(503, 'MERCHANT_UNAVAILABLE', 'Merchant access is temporarily unavailable.');
const unauthorized = () => new ApiError(401, 'AUTH_REQUIRED', 'Sign in to view merchant orders.');
const forbidden = () => new ApiError(403, 'MERCHANT_FORBIDDEN', 'This account does not have merchant access.');

export function merchantAuthConfiguration(env = process.env) {
  if (env.MERCHANT_AUTH_ENABLED !== 'true') return null;
  const url = new URL(env.BETTER_AUTH_URL || 'invalid:');
  const local = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)
    && env.MERCHANT_ALLOW_LOCAL_AUTH === 'true' && !env.VERCEL;
  if ((!local && url.protocol !== 'https:') || !url.hostname || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) throw new Error('A fixed merchant authentication origin is required.');
  if (typeof env.BETTER_AUTH_SECRET !== 'string' || env.BETTER_AUTH_SECRET.length < 32
    || env.BETTER_AUTH_SECRET === env.ORDERS_API_SECRET) throw new Error('An independent authentication secret is required.');
  if (!/^[A-Za-z0-9_.-]{6,128}$/.test(env.GITHUB_CLIENT_ID || '')
    || !/^[A-Za-z0-9_.-]{20,256}$/.test(env.GITHUB_CLIENT_SECRET || '')) throw new Error('GitHub OAuth credentials are required.');
  const ids = (env.MERCHANT_GITHUB_IDS || '').split(',').map((id) => id.trim());
  if (!ids.length || ids.length > 50 || ids.some((id) => !/^[1-9][0-9]{0,19}$/.test(id))) throw new Error('Explicit merchant GitHub account IDs are required.');
  return { origin: url.origin, secure: !local, secret: env.BETTER_AUTH_SECRET,
    clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET, githubIds: new Set(ids) };
}

// The provider's immutable numeric ID is the authorization anchor. An email,
// username, submitted role or client-supplied profile can never grant access.
export function admitMerchantIdentity(source, githubIds) {
  const id = source?.oauth?.profile?.id;
  const normalized = typeof id === 'number' && Number.isSafeInteger(id) ? String(id) : id;
  if (source?.oauth?.providerId !== 'github' || typeof normalized !== 'string'
    || !/^[1-9][0-9]{0,19}$/.test(normalized) || !githubIds.has(normalized)) {
    return { error: 'merchant_access_denied', errorDescription: 'This account does not have merchant access.' };
  }
}

export function merchantAuthOptions(pool, config) {
  return {
    appName: "Joy's Store Merchant",
    baseURL: config.origin,
    basePath: '/api/auth',
    secret: config.secret,
    database: pool,
    trustedOrigins: [config.origin],
    emailAndPassword: { enabled: false },
    socialProviders: { github: { clientId: config.clientId, clientSecret: config.clientSecret } },
    user: { modelName: 'merchant_users', validateUserInfo: ({ source }) => admitMerchantIdentity(source, config.githubIds) },
    session: { modelName: 'merchant_sessions', expiresIn: 8 * 60 * 60,
      disableSessionRefresh: true, cookieCache: { enabled: false } },
    account: { modelName: 'merchant_accounts', encryptOAuthTokens: true,
      accountLinking: { enabled: false }, storeStateStrategy: 'database' },
    verification: { modelName: 'merchant_verifications' },
    rateLimit: { enabled: true, storage: 'database', modelName: 'merchant_rate_limits', window: 60, max: 60,
      customRules: { '/sign-in/social': { window: 60, max: 10 } } },
    advanced: { useSecureCookies: config.secure, cookiePrefix: 'joys_merchant',
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', path: '/' },
      trustedProxyHeaders: false, database: { validateSchema: true } },
    onAPIError: { errorURL: `${config.origin}/admin/sign-in` },
    // Do not emit provider tokens, profiles, request headers or SQL in logs.
    logger: { disabled: true },
    telemetry: { enabled: false },
  };
}

export function createMerchantAuth({ pool, env = process.env }) {
  const config = merchantAuthConfiguration(env);
  if (!config) return null;
  const auth = betterAuth(merchantAuthOptions(pool, config));
  return {
    origin: config.origin,
    handler(request) {
      // This service is consumed through a same-origin BFF. Enforce the exact
      // origin on POST even before a session exists; OAuth GET callbacks use
      // Better Auth's one-time state, signed cookie and PKCE verification.
      if (request.method === 'POST' && (request.headers.get('origin') !== config.origin
        || ['cross-site', 'same-site'].includes(request.headers.get('sec-fetch-site')))) {
        return Response.json({ error: { code: 'MERCHANT_FORBIDDEN', message: 'This request is not allowed.' } }, { status: 403 });
      }
      return auth.handler(request);
    },
    async authorize(request) {
      let session;
      try {
        const headers = request.headers instanceof Headers ? request.headers : fromNodeHeaders(request.headers || {});
        session = await auth.api.getSession({ headers, query: { disableCookieCache: true, disableRefresh: true } });
      } catch { throw unavailable(); }
      if (!session?.user?.id || !session?.session?.id || new Date(session.session.expiresAt).getTime() <= Date.now()) throw unauthorized();
      let accounts;
      try {
        accounts = await pool.query('SELECT "accountId" FROM merchant_accounts WHERE "userId" = $1 AND "providerId" = $2', [session.user.id, 'github']);
      } catch { throw unavailable(); }
      if (!accounts.rows.some((row) => config.githubIds.has(row.accountId))) throw forbidden();
      return { userId: session.user.id, role: 'merchant' };
    },
  };
}
