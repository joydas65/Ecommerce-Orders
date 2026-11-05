-- Explicit enrollment allows one Google sign-in identity per merchant. The
-- application precheck provides a useful denial; this invariant also holds
-- when two independent OAuth callbacks complete at the same time.
CREATE UNIQUE INDEX merchant_accounts_one_google_per_user
  ON merchant_accounts ("userId") WHERE "providerId" = 'google';
