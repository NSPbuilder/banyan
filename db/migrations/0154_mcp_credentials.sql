-- Installation credentials: never included in portable company backups.
CREATE TABLE mcp_credential (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  ledger_id uuid NOT NULL REFERENCES ledger(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  tools text[] NOT NULL CHECK (cardinality(tools) BETWEEN 1 AND 16),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz,
  request_window timestamptz NOT NULL DEFAULT clock_timestamp(),
  request_count integer NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  CHECK (expires_at > created_at)
);
CREATE INDEX mcp_credential_user_idx ON mcp_credential(user_id);
CREATE INDEX mcp_credential_ledger_idx ON mcp_credential(ledger_id);
