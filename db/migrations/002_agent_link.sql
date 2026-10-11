-- Link a conversation to an order without trusting the agent or the browser:
-- the page creates a random key per page load, passes it to the widget as a dynamic variable,
-- and attaches the same key to the order (with the order token). The post-call webhook matches on it.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS agent_links text[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS orders_agent_links_idx ON orders USING gin (agent_links);
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS link_key text;
CREATE INDEX IF NOT EXISTS conversations_link_idx ON conversations (link_key);
INSERT INTO schema_migrations (id) VALUES ('002_agent_link') ON CONFLICT DO NOTHING;
