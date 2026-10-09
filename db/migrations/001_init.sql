-- FRONT v5 · initial schema. Idempotent: safe to run more than once.

CREATE TABLE IF NOT EXISTS schema_migrations (
  id          text PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now()
);

-- Visitor sessions with first/last touch attribution (no PII).
CREATE TABLE IF NOT EXISTS sessions (
  session_id     text PRIMARY KEY,
  anonymous_id   text,
  environment    text NOT NULL,
  first_touch    jsonb,
  last_touch     jsonb,
  device         text,
  started_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_anon_idx ON sessions (anonymous_id);

-- Orders: the source of truth. Contact details live only here (and only after the customer saved them).
CREATE TABLE IF NOT EXISTS orders (
  order_id          text PRIMARY KEY,
  token_hash        text NOT NULL,
  environment       text NOT NULL,
  status            text NOT NULL DEFAULT 'created',   -- created | checkout | approved | paid | pending | failed | refunded
  amount            numeric(10,2) NOT NULL,
  currency          text NOT NULL,
  product           text NOT NULL,
  anonymous_id      text,
  session_id        text,
  attribution       jsonb,                              -- first/last touch snapshot at order time
  consent           jsonb,                              -- {analytics, ads} at order time
  meta_user         jsonb,                              -- fbc, fbp, ip, ua captured at order time (only if ads consent)
  paypal_order_id   text UNIQUE,
  paid_at           timestamptz,
  paid_via          text,                               -- paypal | bit_manual
  contact           jsonb,                              -- {name, phone, email}
  brief             jsonb NOT NULL DEFAULT '{}'::jsonb,
  brief_started_at  timestamptz,
  brief_done_at     timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status, created_at);
CREATE INDEX IF NOT EXISTS orders_session_idx ON orders (session_id);

-- Payment records. capture_id UNIQUE = one purchase per capture, whatever arrives twice.
CREATE TABLE IF NOT EXISTS payments (
  id               bigserial PRIMARY KEY,
  order_id         text NOT NULL REFERENCES orders(order_id),
  provider         text NOT NULL,                       -- paypal | bit_manual
  capture_id       text UNIQUE,
  status           text NOT NULL,                       -- COMPLETED | PENDING | DECLINED | FAILED | REFUNDED | MANUAL_OK
  amount           numeric(10,2),
  currency         text,
  payee_merchant   text,
  raw              jsonb,
  verified_by      text,                                -- admin user for manual verifications
  reference        text,                                -- bank/Bit reference for manual verifications
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payments_order_idx ON payments (order_id);

-- Every webhook delivery we accepted (dedupe by provider event id).
CREATE TABLE IF NOT EXISTS webhook_events (
  provider      text NOT NULL,
  event_id      text NOT NULL,
  event_type    text,
  verified      boolean NOT NULL,
  processed_at  timestamptz,
  error         text,
  received_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id)
);

-- Analytics + lifecycle events (no PII; see ANALYTICS_CONTRACT.md).
CREATE TABLE IF NOT EXISTS events (
  event_id         text PRIMARY KEY,
  event_name       text NOT NULL,
  occurred_at      timestamptz NOT NULL,
  received_at      timestamptz NOT NULL DEFAULT now(),
  anonymous_id     text,
  session_id       text,
  conversation_id  text,
  lead_id          text,
  order_id         text,
  page_path        text,
  cta_location     text,
  channel          text NOT NULL,
  site_version     text,
  agent_version    text,
  environment      text NOT NULL,
  consent_state    jsonb,
  props            jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS events_name_time_idx ON events (environment, event_name, occurred_at);
CREATE INDEX IF NOT EXISTS events_session_idx ON events (session_id);
CREATE INDEX IF NOT EXISTS events_order_idx ON events (order_id);

-- Conversations from ElevenLabs post-call webhook. Transcript stays here (admin only).
CREATE TABLE IF NOT EXISTS conversations (
  conversation_id   text PRIMARY KEY,
  agent_id          text,
  agent_version     text,
  environment       text NOT NULL,
  anonymous_id      text,
  session_id        text,
  order_id          text,
  status            text,
  started_at        timestamptz,
  duration_secs     integer,
  user_turns        integer,
  agent_turns       integer,
  first_user_at_secs numeric,
  data_collection   jsonb,
  summary           text,
  transcript        jsonb,
  termination_reason text,
  received_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversations_order_idx ON conversations (order_id);
CREATE INDEX IF NOT EXISTS conversations_session_idx ON conversations (session_id);

-- Meta CAPI outbox: one Purchase per order, retried until sent.
CREATE TABLE IF NOT EXISTS meta_outbox (
  event_id      text PRIMARY KEY,                       -- = order_id for Purchase
  event_name    text NOT NULL,
  payload       jsonb NOT NULL,
  attempts      integer NOT NULL DEFAULT 0,
  sent_at       timestamptz,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Who did what in admin.
CREATE TABLE IF NOT EXISTS admin_audit (
  id          bigserial PRIMARY KEY,
  admin_user  text NOT NULL,
  action      text NOT NULL,
  order_id    text,
  details     jsonb,
  at          timestamptz NOT NULL DEFAULT now()
);

-- Rate limiting buckets (per key per minute).
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket     text NOT NULL,
  win_start  timestamptz NOT NULL,
  hits       integer NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, win_start)
);

INSERT INTO schema_migrations (id) VALUES ('001_init') ON CONFLICT DO NOTHING;
