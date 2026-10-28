-- A Finder/WebDAV password is separate from the browser session and scoped to
-- one person and one company. Only its SHA-256 is stored; the random 256-bit
-- password is shown once when created or replaced.
CREATE TABLE webdav_credential (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  entity_id    uuid NOT NULL REFERENCES entity(id),
  token_hash   text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz,
  UNIQUE (user_id, entity_id),
  UNIQUE (token_hash)
);

CREATE INDEX webdav_credential_entity_idx ON webdav_credential (entity_id, user_id)
  WHERE revoked_at IS NULL;

COMMENT ON TABLE webdav_credential IS
  'One revocable, read-only WebDAV password per user and company. The raw password is never stored.';
