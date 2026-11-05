import { verifyProviderIdToken } from 'better-auth/oauth2';

// Better Auth 1.7.15 exposes the Google verifier for client ID-token flows,
// while its redirect getUserInfo decodes the token from the HTTPS exchange.
// Apply the same signature/issuer/audience checks to redirect flows as well,
// and bind each ID token to the nonce saved in the one-time OAuth state.
export function verifiedGoogleIdentity() {
  return {
    id: 'joys-google-identity',
    init(context) {
      const provider = context.socialProviders.find((entry) => entry.id === 'google');
      if (!provider) return;
      const createAuthorizationURL = provider.createAuthorizationURL.bind(provider);
      const getUserInfo = provider.getUserInfo.bind(provider);
      provider.requiresIdTokenNonce = true;
      provider.createAuthorizationURL = async (input) => {
        if (typeof input.idTokenNonce !== 'string' || !input.idTokenNonce) throw new Error('An OAuth nonce is required.');
        const url = await createAuthorizationURL(input);
        url.searchParams.set('nonce', input.idTokenNonce);
        return url;
      };
      provider.getUserInfo = async (tokens) => {
        if (typeof tokens.idToken !== 'string' || typeof tokens.expectedIdTokenNonce !== 'string' || !tokens.expectedIdTokenNonce
          || !await verifyProviderIdToken(provider, tokens.idToken, tokens.expectedIdTokenNonce)) return null;
        const result = await getUserInfo(tokens);
        return result?.user?.emailVerified === true ? result : null;
      };
    },
  };
}
