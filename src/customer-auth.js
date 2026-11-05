import { betterAuth } from 'better-auth';
import { fromNodeHeaders } from 'better-auth/node';
import { ApiError } from './errors.js';
import { verifiedGoogleIdentity } from './google-identity.js';

const unavailable = () => new ApiError(503, 'CUSTOMER_UNAVAILABLE', 'Customer sign-in is temporarily unavailable.');
const unauthorized = () => new ApiError(401, 'AUTH_REQUIRED', 'Sign in to view your orders.');
const googleSubject = (value) => typeof value === 'string' && /^[\x21-\x7e]{1,255}$/.test(value);

export function customerAuthConfiguration(env = process.env) {
  if (env.CUSTOMER_AUTH_ENABLED !== 'true') return null;
  const url = new URL(env.CUSTOMER_AUTH_URL || 'invalid:');
  const local = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)
    && env.CUSTOMER_ALLOW_LOCAL_AUTH === 'true' && !env.VERCEL;
  if ((!local && url.protocol !== 'https:') || !url.hostname || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) throw new Error('A fixed customer authentication origin is required.');
  if (typeof env.CUSTOMER_AUTH_SECRET !== 'string' || env.CUSTOMER_AUTH_SECRET.length < 32
    || [env.ORDERS_API_SECRET, env.BETTER_AUTH_SECRET].includes(env.CUSTOMER_AUTH_SECRET)) throw new Error('An independent customer authentication secret is required.');
  if (!/^[A-Za-z0-9_.-]{6,256}$/.test(env.GOOGLE_CLIENT_ID || '')
    || !/^[A-Za-z0-9_.-]{20,256}$/.test(env.GOOGLE_CLIENT_SECRET || '')) throw new Error('Google OAuth credentials are required.');
  return { origin: url.origin, secure: !local, secret: env.CUSTOMER_AUTH_SECRET,
    clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
}

// Called only with the library's verified OAuth response. Display names,
// requested roles, submitted emails and identities from other providers confer no authority.
export function admitCustomerIdentity(source) {
  const profile = source?.oauth?.profile;
  if (source?.oauth?.providerId !== 'google' || !googleSubject(profile?.sub)
    || profile.email_verified !== true || typeof profile.email !== 'string' || !profile.email.trim()) {
    return { error: 'customer_access_denied', errorDescription: 'Use a verified Google account to sign in.' };
  }
}

export function customerAuthOptions(pool, config) {
  return {
    appName: "Joy's Store",
    baseURL: config.origin, basePath: '/api/customer-auth', secret: config.secret, database: pool,
    trustedOrigins: [config.origin], emailAndPassword: { enabled: false },
    socialProviders: { google: { clientId: config.clientId, clientSecret: config.clientSecret,
      prompt: 'select_account', includeGrantedScopes: false } },
    user: { modelName: 'customer_users', validateUserInfo: ({ source }) => admitCustomerIdentity(source) },
    session: { modelName: 'customer_sessions', expiresIn: 8 * 60 * 60,
      disableSessionRefresh: true, cookieCache: { enabled: false } },
    account: { modelName: 'customer_accounts', encryptOAuthTokens: true,
      accountLinking: { enabled: false }, storeStateStrategy: 'database' },
    verification: { modelName: 'customer_verifications' },
    rateLimit: { enabled: true, storage: 'database', modelName: 'customer_rate_limits', window: 60, max: 60,
      customRules: { '/sign-in/social': { window: 60, max: 10 } } },
    advanced: { useSecureCookies: config.secure, cookiePrefix: 'joys_customer',
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', path: '/' },
      trustedProxyHeaders: false, database: { validateSchema: true } },
    onAPIError: { errorURL: `${config.origin}/account/sign-in`, throw: true },
    plugins: [verifiedGoogleIdentity()],
    logger: { disabled: true }, telemetry: { enabled: false },
  };
}

export function createCustomerAuth({ pool, env = process.env }) {
  const config = customerAuthConfiguration(env);
  if (!config) return null;
  const auth = betterAuth(customerAuthOptions(pool, config));
  return {
    origin: config.origin,
    async handler(request) {
      if (request.method === 'POST' && (request.headers.get('origin') !== config.origin
        || ['cross-site', 'same-site'].includes(request.headers.get('sec-fetch-site')))) {
        return Response.json({ error: { code: 'AUTH_ORIGIN_INVALID', message: 'Open sign-in from the storefront.' } }, { status: 403 });
      }
      // Better Call otherwise logs unexpected adapter errors even when the
      // Better Auth logger is disabled. Keep SQL, tokens and profile metadata
      // out of responses and process logs; users can restart OAuth safely.
      try { return await auth.handler(request); }
      catch {
        return Response.json({ error: { code: 'CUSTOMER_UNAVAILABLE', message: 'Customer sign-in is temporarily unavailable.' } }, { status: 503 });
      }
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
        accounts = await pool.query('SELECT "accountId" FROM customer_accounts WHERE "userId" = $1 AND "providerId" = $2', [session.user.id, 'google']);
      } catch { throw unavailable(); }
      if (session.user.emailVerified !== true || !accounts.rows.some((row) => googleSubject(row.accountId))) throw unauthorized();
      const displayName = typeof session.user.name === 'string'
        ? session.user.name.normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 80) : '';
      return { userId: session.user.id, role: 'customer', displayName: displayName || 'Shopper' };
    },
  };
}
