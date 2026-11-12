-- Admin sign-in by a one-time link mailed to ADMIN_EMAIL. Only hashes of the login and session tokens are stored.
CREATE TABLE IF NOT EXISTS admin_tokens (
  token_hash  text PRIMARY KEY,
  kind        text NOT NULL,                          -- login | session
  email       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz                             -- login: redeemed; session: signed out
);

INSERT INTO schema_migrations (id) VALUES ('005_admin_login') ON CONFLICT DO NOTHING;
