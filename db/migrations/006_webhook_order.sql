-- Which order a payment webhook belonged to, and how many times the same delivery arrived (a resend is counted, never reprocessed).
ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS order_id text;
ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS deliveries integer NOT NULL DEFAULT 1;
ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS last_received_at timestamptz;
CREATE INDEX IF NOT EXISTS webhook_events_order_idx ON webhook_events (order_id) WHERE order_id IS NOT NULL;

INSERT INTO schema_migrations (id) VALUES ('006_webhook_order') ON CONFLICT DO NOTHING;
