-- "Help with an order" requests from the site. The customer gives an email and a description; an order is attached
-- only when the request came from a verified order page (its token checked). A number typed by hand is kept as text
-- (claimed_order_ref) and never grants access to the order. One row per client_ref: a repeated send is not a second request.
CREATE TABLE IF NOT EXISTS support_requests (
  id                bigserial PRIMARY KEY,
  client_ref        text NOT NULL UNIQUE,
  environment       text NOT NULL,
  email             text NOT NULL,
  message           text NOT NULL,
  order_id          text REFERENCES orders(order_id),
  claimed_order_ref text,
  source            text,
  status            text NOT NULL DEFAULT 'open',      -- open | done
  handled_at        timestamptz,
  handled_by        text,
  notify_status     text NOT NULL DEFAULT 'pending',   -- pending | sent | failed (owner email through Make)
  notify_attempts   integer NOT NULL DEFAULT 0,
  notify_next_at    timestamptz NOT NULL DEFAULT now(),
  notify_error      text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS support_requests_open_idx ON support_requests (environment, status, created_at);
CREATE INDEX IF NOT EXISTS support_requests_notify_idx ON support_requests (notify_status, notify_next_at);

INSERT INTO schema_migrations (id) VALUES ('008_support') ON CONFLICT DO NOTHING;
