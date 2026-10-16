-- 003 · Durable queues and recovery.
-- Meta outbox: the payload is built at send time from the order, so consent and refunds are checked when sending.
ALTER TABLE meta_outbox ADD COLUMN IF NOT EXISTS order_id text;
ALTER TABLE meta_outbox ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending';   -- pending | sent | no_consent | cancelled_refund | expired | failed
ALTER TABLE meta_outbox ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE meta_outbox ALTER COLUMN payload DROP NOT NULL;
UPDATE meta_outbox SET order_id = event_id WHERE order_id IS NULL;
UPDATE meta_outbox SET status = 'sent' WHERE sent_at IS NOT NULL AND status = 'pending';
CREATE INDEX IF NOT EXISTS meta_outbox_due_idx ON meta_outbox (status, next_attempt_at);

-- Email notifications (via Make). One row per message; retried until Make confirms.
CREATE TABLE IF NOT EXISTS notify_outbox (
  id               text PRIMARY KEY,                    -- e.g. paid:FR-XXXX-XXXX, finish:FR-XXXX-XXXX
  action           text NOT NULL,                       -- paid | finish
  order_id         text NOT NULL,
  status           text NOT NULL DEFAULT 'pending',     -- pending | sent | failed
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  last_error       text,
  sent_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notify_outbox_due_idx ON notify_outbox (status, next_attempt_at);

-- Webhook deliveries keep their raw body until processed, so a failed processing step can be replayed.
ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS payload jsonb;
ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS environment text;
CREATE INDEX IF NOT EXISTS webhook_events_pending_idx ON webhook_events (provider, processed_at) WHERE processed_at IS NULL;

INSERT INTO schema_migrations (id) VALUES ('003_durable_queues') ON CONFLICT DO NOTHING;
