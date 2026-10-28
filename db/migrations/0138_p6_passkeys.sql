-- Credentials belong to existing users, sessions and recovery policy.
ALTER TABLE app_user ADD COLUMN webauthn_user_id bytea NOT NULL DEFAULT gen_random_bytes(32);
CREATE UNIQUE INDEX app_user_webauthn_handle ON app_user(webauthn_user_id);
CREATE TABLE auth_passkey (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  credential_id text NOT NULL UNIQUE,
  public_key bytea NOT NULL,
  algorithm integer NOT NULL,
  counter bigint NOT NULL CHECK(counter>=0 AND counter<=4294967295),
  device_type text NOT NULL CHECK(device_type IN ('singleDevice','multiDevice')),
  backed_up boolean NOT NULL,
  transports jsonb NOT NULL DEFAULT '[]',
  rp_id text NOT NULL, origin text NOT NULL,
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
  aaguid text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_used_at timestamptz, revoked_at timestamptz
);
CREATE INDEX auth_passkey_user ON auth_passkey(user_id) WHERE revoked_at IS NULL;
ALTER TABLE user_session ADD COLUMN strong_authenticated_at timestamptz,
  ADD COLUMN authenticated_passkey_id uuid REFERENCES auth_passkey(id) ON DELETE SET NULL;
CREATE TABLE auth_webauthn_challenge (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES app_user(id) ON DELETE CASCADE,
  session_hash text REFERENCES user_session(token_hash) ON DELETE CASCADE,
  browser_hash text NOT NULL,
  flow text NOT NULL CHECK(flow IN ('register','login','reauth')),
  challenge text NOT NULL UNIQUE,
  rp_id text NOT NULL, origin text NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '5 minutes',
  consumed_at timestamptz,
  CHECK((flow='login' AND user_id IS NULL AND session_hash IS NULL) OR
    (flow IN ('register','reauth') AND user_id IS NOT NULL AND session_hash IS NOT NULL))
);
CREATE INDEX auth_webauthn_expiry ON auth_webauthn_challenge(expires_at);
