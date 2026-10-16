-- Owner operations: continuation links, production stages, delivery targets, customer delays, password sign-in.

-- Extra access links to an existing order, issued by an authenticated admin. Only token hashes are stored.
-- Issuing one never touches the customer's original link (orders.token_hash) or earlier issued links.
CREATE TABLE IF NOT EXISTS order_access (
  id          bigserial PRIMARY KEY,
  order_id    text NOT NULL REFERENCES orders(order_id),
  token_hash  text NOT NULL UNIQUE,
  request_id  text UNIQUE,                            -- one link per click: a repeated request never issues a second link
  issued_by   text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  revoked_by  text
);
CREATE INDEX IF NOT EXISTS order_access_order_idx ON order_access (order_id);

-- Production stage, kept apart from payment and brief. NULL = never set by the owner (the dashboard infers only
-- "awaiting brief" or "script writing" from the stored brief state, and says it is inferred).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS production_stage text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS production_stage_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS first_delivered_at timestamptz;    -- never overwritten by a later delivery
ALTER TABLE orders ADD COLUMN IF NOT EXISTS last_delivered_at timestamptz;
-- Delivery target: base = 7 business days (Sun-Thu, Israel time) after the paid day; override = owner's correction with a reason.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS due_base date;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS due_override date;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS due_override_reason text;

CREATE TABLE IF NOT EXISTS order_stage_log (
  id          bigserial PRIMARY KEY,
  order_id    text NOT NULL REFERENCES orders(order_id),
  from_stage  text,
  to_stage    text NOT NULL,
  changed_by  text NOT NULL,
  changed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS order_stage_log_order_idx ON order_stage_log (order_id, changed_at);

-- Customer-caused delays (materials, brief, script approval). Our own internal waiting is not recorded here.
CREATE TABLE IF NOT EXISTS order_delays (
  id            bigserial PRIMARY KEY,
  order_id      text NOT NULL REFERENCES orders(order_id),
  started_on    date NOT NULL,
  ended_on      date,                                 -- NULL = still open (counts up to today)
  reason        text NOT NULL,
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  ended_by      text,
  ended_at      timestamptz,
  cancelled_at  timestamptz,                          -- entered by mistake: kept for the record, not counted
  cancelled_by  text
);
CREATE UNIQUE INDEX IF NOT EXISTS order_delays_once ON order_delays (order_id, started_on, reason) WHERE cancelled_at IS NULL;

-- Owner password (scrypt hash only). Set or reset only from a session opened by the one-time mailed link.
CREATE TABLE IF NOT EXISTS admin_credentials (
  email          text PRIMARY KEY,
  password_hash  text NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
-- How a session was opened: link | password | basic (password setting is allowed only right after a link sign-in).
ALTER TABLE admin_tokens ADD COLUMN IF NOT EXISTS origin text;

INSERT INTO schema_migrations (id) VALUES ('007_operations') ON CONFLICT DO NOTHING;
