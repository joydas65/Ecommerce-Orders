CREATE TABLE merchant_payment_check_attempts (
  id uuid PRIMARY KEY,
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128),
  actor_label text NOT NULL CHECK (length(actor_label) BETWEEN 1 AND 80),
  request_id uuid NOT NULL,
  order_id text NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  session_id text NOT NULL CHECK (session_id ~ '^cs_test_[A-Za-z0-9]+$'),
  requested_at timestamptz NOT NULL,
  lease_token uuid NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  result_event_id uuid,
  UNIQUE (actor_id, request_id),
  CHECK ((completed_at IS NULL) = (result_event_id IS NULL))
);
CREATE UNIQUE INDEX merchant_payment_check_active_order ON merchant_payment_check_attempts(order_id) WHERE completed_at IS NULL;
CREATE INDEX merchant_payment_check_actor_time ON merchant_payment_check_attempts(actor_id, requested_at DESC);
CREATE INDEX merchant_payment_check_order_time ON merchant_payment_check_attempts(order_id, requested_at DESC);

-- Application code only INSERTs events. They follow order retention and may be
-- deleted by its FK cascade; this is not tamper-proof or permanent storage.
-- Actor IDs intentionally have no user FK: identity deletion must not erase an
-- otherwise retained order's operational history.
CREATE TABLE merchant_payment_check_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY,
  id uuid PRIMARY KEY,
  attempt_id uuid NOT NULL REFERENCES merchant_payment_check_attempts(id) ON DELETE CASCADE,
  order_id text NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  actor_id text NOT NULL,
  actor_label text NOT NULL,
  occurred_at timestamptz NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('requested','paid','pending','canceled','review_required','provider_unavailable','already_resolved','interrupted')),
  previous_payment_status text NOT NULL CHECK (previous_payment_status IN ('PENDING','PAID','CANCELED','REQUIRES_REVIEW')),
  result_payment_status text NOT NULL CHECK (result_payment_status IN ('PENDING','PAID','CANCELED','REQUIRES_REVIEW'))
);
CREATE UNIQUE INDEX merchant_payment_check_one_requested ON merchant_payment_check_events(attempt_id) WHERE outcome = 'requested';
CREATE UNIQUE INDEX merchant_payment_check_one_result ON merchant_payment_check_events(attempt_id) WHERE outcome <> 'requested';
CREATE INDEX merchant_payment_check_history ON merchant_payment_check_events(order_id, sequence DESC);
