-- Customer receipt email (payment confirmed + personal link) for customers who postpone the brief.
-- The link carries the order token, which the server otherwise keeps only as a hash, so it is held
-- here until the email is delivered and then erased.
ALTER TABLE notify_outbox ADD COLUMN IF NOT EXISTS secret_link text;

INSERT INTO schema_migrations (id) VALUES ('004_receipt') ON CONFLICT DO NOTHING;
