CREATE TABLE checkout_quotes (
  id text PRIMARY KEY CHECK (id ~ '^quote_[0-9a-f-]{36}$'),
  guest_id uuid NOT NULL,
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, guest_id)
);

CREATE TABLE orders (
  id text PRIMARY KEY CHECK (id ~ '^order_[0-9a-f-]{36}$'),
  quote_id text NOT NULL UNIQUE,
  guest_id uuid NOT NULL,
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt) = 'object'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (id, guest_id),
  FOREIGN KEY (quote_id, guest_id) REFERENCES checkout_quotes(id, guest_id)
);

CREATE TABLE order_submissions (
  guest_id uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  order_id text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (guest_id, idempotency_key),
  FOREIGN KEY (order_id, guest_id) REFERENCES orders(id, guest_id) ON DELETE CASCADE
);

CREATE INDEX checkout_quotes_expiry ON checkout_quotes(expires_at);
CREATE INDEX orders_expiry ON orders(expires_at);
