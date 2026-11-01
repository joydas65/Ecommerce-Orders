-- Keyset pagination uses a unique, stable tie-breaker for identical timestamps.
CREATE INDEX orders_merchant_created ON orders (created_at DESC, id DESC);
CREATE INDEX orders_merchant_payment_created ON orders ((receipt->>'paymentStatus'), created_at DESC, id DESC);
