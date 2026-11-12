-- A short summary of the conversation's direction, emailed only when the customer asked or explicitly agreed (Meital's
-- send_summary tool). One row per client_ref (same conversation + same address): a repeated call or a retry is not a
-- second email. Nothing here creates or changes an order or a payment, and the address is used for this email only
-- (no list, no follow-up sequence).
CREATE TABLE IF NOT EXISTS summary_requests (
  id               bigserial PRIMARY KEY,
  client_ref       text NOT NULL UNIQUE,
  environment      text NOT NULL,
  email            text NOT NULL,
  direction        text NOT NULL,
  facts            text,                                -- what the customer said, from the saved brief at request time
  order_id         text REFERENCES orders(order_id),    -- only when the page proved it owns the (unpaid or paid) order
  session_id       text,
  status           text NOT NULL DEFAULT 'pending',     -- pending | sent | failed | not_allowed (test environment, address not a test recipient) | limited (abuse limit)
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  sent_at          timestamptz
);
CREATE INDEX IF NOT EXISTS summary_requests_due_idx ON summary_requests (status, next_attempt_at);

INSERT INTO schema_migrations (id) VALUES ('009_summary') ON CONFLICT DO NOTHING;
