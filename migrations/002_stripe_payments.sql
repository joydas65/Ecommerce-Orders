ALTER TABLE checkout_quotes ADD COLUMN payment_provider text NOT NULL DEFAULT 'simulated'
  CHECK (payment_provider IN ('simulated', 'stripe-test'));
ALTER TABLE checkout_quotes ADD UNIQUE (id, guest_id, payment_provider);
ALTER TABLE orders ADD COLUMN payment_provider text NOT NULL DEFAULT 'simulated'
  CHECK (payment_provider IN ('simulated', 'stripe-test'));
ALTER TABLE orders ADD CONSTRAINT order_quote_payment_provider
  FOREIGN KEY (quote_id, guest_id, payment_provider) REFERENCES checkout_quotes(id, guest_id, payment_provider);

CREATE TABLE payment_sessions (
  order_id text PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  stripe_session_id text UNIQUE,
  payment_intent_id text UNIQUE,
  create_key text NOT NULL UNIQUE,
  create_params jsonb NOT NULL,
  first_attempt_at timestamptz NOT NULL,
  session_expires_at timestamptz
);

CREATE TABLE stripe_events (
  event_id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  session_id text NOT NULL,
  event_type text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);
