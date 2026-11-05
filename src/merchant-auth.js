import { betterAuth } from 'better-auth';
import { fromNodeHeaders } from 'better-auth/node';
import { ApiError } from './errors.js';
import { verifiedGoogleIdentity } from './google-identity.js';

const unavailable = () => new ApiError(503, 'MERCHANT_UNAVAILABLE', 'Merchant access is temporarily unavailable.');
const unauthorized = () => new ApiError(401, 'AUTH_REQUIRED', 'Sign in to view merchant orders.');
const forbidden = () => new ApiError(403, 'MERCHANT_FORBIDDEN', 'This account does not have merchant access.');
const deniedIdentity = () => ({ error: 'merchant_access_denied', errorDescription: 'This account does not have merchant access.' });
const googleSubject = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,255}$/.test(value);

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
  let google = null;
  if (env.MERCHANT_GOOGLE_ENABLED === 'true') {
    if (!/^[A-Za-z0-9_-]{6,200}\.apps\.googleusercontent\.com$/.test(env.GOOGLE_CLIENT_ID || '')
      || !/^[A-Za-z0-9_.-]{20,256}$/.test(env.GOOGLE_CLIENT_SECRET || '')) throw new Error('Google OAuth credentials are required.');
    google = { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
  }
  return { origin: url.origin, secure: !local, secret: env.BETTER_AUTH_SECRET, google,
    clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET, githubIds: new Set(ids) };
}

// The provider's immutable numeric ID is the authorization anchor. An email,
// username, submitted role or client-supplied profile can never grant access.
export function admitMerchantIdentity(source, githubIds) {
  const id = source?.oauth?.profile?.id;
  const normalized = typeof id === 'number' && Number.isSafeInteger(id) ? String(id) : id;
  if (source?.oauth?.providerId !== 'github' || source.action === 'link-account' || typeof normalized !== 'string'
    || !/^[1-9][0-9]{0,19}$/.test(normalized) || !githubIds.has(normalized)) {
    return deniedIdentity();
  }
}

export function merchantAuthOptions(pool, config, validateGoogle = async () => deniedIdentity()) {
  return {
    appName: "Joy's Store Merchant",
    plugins: [verifiedGoogleIdentity()],
    baseURL: config.origin,
    basePath: '/api/auth',
    secret: config.secret,
    database: pool,
    trustedOrigins: [config.origin],
    emailAndPassword: { enabled: false },
    socialProviders: {
      github: { clientId: config.clientId, clientSecret: config.clientSecret },
      ...(config.google ? { google: { ...config.google, disableSignUp: true, includeGrantedScopes: false, accessType: 'online', prompt: 'select_account' } } : {}),
    },
    user: { modelName: 'merchant_users', validateUserInfo: (data, context) => data.source?.oauth?.providerId === 'google'
      ? validateGoogle(data, context) : admitMerchantIdentity(data.source, config.githubIds) },
    session: { modelName: 'merchant_sessions', expiresIn: 8 * 60 * 60,
      disableSessionRefresh: true, cookieCache: { enabled: false } },
    account: { modelName: 'merchant_accounts', encryptOAuthTokens: true,
      // Google is linked only through an explicit authenticated flow; matching
      // emails never imply that two provider identities belong to one merchant.
      accountLinking: { enabled: Boolean(config.google), disableImplicitLinking: true, allowDifferentEmails: true }, storeStateStrategy: 'database' },
    verification: { modelName: 'merchant_verifications' },
    rateLimit: { enabled: true, storage: 'database', modelName: 'merchant_rate_limits', window: 60, max: 60,
      customRules: { '/sign-in/social': { window: 60, max: 10 }, '/link-social': { window: 60, max: 5 } } },
    advanced: { useSecureCookies: config.secure, cookiePrefix: 'joys_merchant',
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', path: '/' },
      trustedProxyHeaders: false, database: { validateSchema: true } },
    // Propagate unexpected adapter failures to the safe wrapper below. Better
    // Call otherwise logs raw database errors even with the logger disabled.
    onAPIError: { errorURL: `${config.origin}/admin/sign-in`, throw: true },
    // Do not emit provider tokens, profiles, request headers or SQL in logs.
    logger: { disabled: true },
    telemetry: { enabled: false },
  };
}

export function createMerchantAuth({ pool, env = process.env }) {
  const config = merchantAuthConfiguration(env);
  if (!config) return null;
  async function approvedGitHub(userId) {
    const accounts = await pool.query('SELECT "accountId" FROM merchant_accounts WHERE "userId" = $1 AND "providerId" = $2', [userId, 'github']);
    return accounts.rows.some((row) => config.githubIds.has(row.accountId));
  }
  const auth = betterAuth(merchantAuthOptions(pool, config, async ({ user, source }, context) => {
    const profile = source?.oauth?.profile;
    if (!config.google || !googleSubject(profile?.sub) || profile.email_verified !== true || !user?.id) return deniedIdentity();
    if (source.action === 'link-account') {
      // The OAuth state binds the requested target; require the same live
      // merchant session again on return so logout, expiry or revocation wins.
      const identity = await authorize(context.request || { headers: context.headers });
      if (identity.userId !== user.id) return deniedIdentity();
      const existing = await pool.query('SELECT "accountId" FROM merchant_accounts WHERE "userId" = $1 AND "providerId" = $2', [user.id, 'google']);
      if (existing.rows.some((row) => row.accountId !== profile.sub)) return deniedIdentity();
      return;
    }
    if (source.action !== 'sign-in') return deniedIdentity();
    const linked = await pool.query('SELECT "userId" FROM merchant_accounts WHERE "providerId" = $1 AND "accountId" = $2', ['google', profile.sub]);
    if (linked.rows.length !== 1 || linked.rows[0].userId !== user.id || !await approvedGitHub(user.id)) return deniedIdentity();
  }));
  async function authorize(request) {
    let session;
    try {
      const headers = request.headers instanceof Headers ? request.headers : fromNodeHeaders(request.headers || {});
      session = await auth.api.getSession({ headers, query: { disableCookieCache: true, disableRefresh: true } });
    } catch { throw unavailable(); }
    if (!session?.user?.id || !session?.session?.id || new Date(session.session.expiresAt).getTime() <= Date.now()) throw unauthorized();
    let approved;
    try { approved = await approvedGitHub(session.user.id); } catch { throw unavailable(); }
    if (!approved) throw forbidden();
    return { userId: session.user.id, role: 'merchant' };
  }
  return {
    origin: config.origin,
    enabledProviders: ['github', ...(config.google ? ['google'] : [])],
    async handler(request) {
      // This service is consumed through a same-origin BFF. Enforce the exact
      // origin on POST even before a session exists; OAuth GET callbacks use
      // Better Auth's one-time state, signed cookie and PKCE verification.
      if (request.method === 'POST' && (request.headers.get('origin') !== config.origin
        || ['cross-site', 'same-site'].includes(request.headers.get('sec-fetch-site')))) {
        return Response.json({ error: { code: 'MERCHANT_FORBIDDEN', message: 'This request is not allowed.' } }, { status: 403 });
      }
      if (new URL(request.url).pathname === '/api/auth/link-social') {
        try {
          if (!config.google) return Response.json({ error: { code: 'MERCHANT_UNAVAILABLE', message: 'Google sign-in is not configured.' } }, { status: 503 });
          if (request.method !== 'POST') return Response.json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'This request is not allowed.' } }, { status: 405 });
          const input = await request.clone().json();
          if (!input || typeof input !== 'object' || Array.isArray(input)
            || Object.keys(input).sort().join(',') !== 'callbackURL,errorCallbackURL,provider' || input.provider !== 'google'
            || input.callbackURL !== '/admin/orders' || input.errorCallbackURL !== '/admin/sign-in') {
            return Response.json({ error: { code: 'INVALID_REQUEST', message: 'This request is not allowed.' } }, { status: 400 });
          }
          await authorize(request);
        } catch (error) {
          return Response.json({ error: { code: error instanceof ApiError ? error.code : 'INVALID_REQUEST', message: 'Google linking could not be started.' } }, { status: error instanceof ApiError ? error.status : 400 });
        }
      }
      try { return await auth.handler(request); }
      catch (error) {
        if (new URL(request.url).pathname === '/api/auth/callback/google' && error?.code === '23505'
          && ['merchant_accounts_one_google_per_user', 'merchant_accounts_provider_identity'].includes(error.constraint)) {
          return new Response(null, { status: 302, headers: { Location: '/admin/sign-in?error=merchant_google_already_linked', 'Cache-Control': 'private, no-store' } });
        }
        return Response.json({ error: { code: 'MERCHANT_UNAVAILABLE', message: 'Merchant sign-in is temporarily unavailable.' } },
          { status: 503, headers: { 'Cache-Control': 'private, no-store' } });
      }
    },
    authorize,
    async accountStatus(request) {
      const identity = await authorize(request);
      if (!config.google) return { googleEnabled: false, googleLinked: false };
      let linked;
      try { linked = await pool.query('SELECT 1 FROM merchant_accounts WHERE "userId" = $1 AND "providerId" = $2', [identity.userId, 'google']); }
      catch { throw unavailable(); }
      return { googleEnabled: true, googleLinked: linked.rows.length > 0 };
    },
  };
}
