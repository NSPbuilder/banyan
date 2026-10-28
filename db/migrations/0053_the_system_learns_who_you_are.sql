-- 0053 — the system learns who you are
--
-- RISKS §15 has said since the beginning that nothing here knows a person:
-- `audit_log.actor`, `account.created_by` and every column like them record the
-- SURFACE a change came through ('web', 'system', a script's own name), not a
-- human being. §15b, written 2026-09-04 when the owner began planning to put
-- this on a VPS, restates it as the access-control fact it becomes the moment
-- the port is reachable: anyone who can open the page is the administrator.
--
-- This migration is the first half of closing both. It adds people and the
-- sessions that prove who they are. The second half is in the application: a
-- gate every page and every route passes through, and `actor` carrying an
-- identity instead of a surface.
--
-- WHY IT CANNOT WAIT FOR THE SECOND PERSON (RISKS §15): the history written
-- between "a second person starts using this" and "identity is added" can never
-- be attributed to anybody. There is no repair for it afterwards.

-- -----------------------------------------------------------------------------
-- 1. People.
-- -----------------------------------------------------------------------------
CREATE TABLE app_user (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The identity that goes in the audit trail. Lower-cased on the way in, so
  -- Alicio@… and alicio@… are one person and not two.
  -- The SAME rule the application applies (`cleanEmail`), not a looser one.
  -- A looser CHECK lets a row in by SQL that the sign-in form can never match,
  -- and the refusal the person meets says BAD_CREDENTIALS (critic).
  email         text NOT NULL
                CHECK (email = lower(email)
                       AND email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  display_name  text NOT NULL CHECK (length(trim(display_name)) > 0),

  -- scrypt, from node:crypto — no dependency, and the parameters travel WITH
  -- the hash (`scrypt$N$r$p$salt$hash`) so raising the cost later does not
  -- invalidate everybody's password.
  password_hash text NOT NULL,

  -- An owner may manage users and take a backup. Everybody else may keep books.
  -- This is deliberately ONE bit and not a role system: per-company permissions
  -- are a real design question (RISKS §15b, "what a login still would not give
  -- you") and inventing half of one here would be the thing to regret.
  is_owner      boolean NOT NULL DEFAULT false,

  -- Deactivating keeps the audit trail readable; deleting a user would orphan
  -- every row that names them. There is no delete.
  is_active     boolean NOT NULL DEFAULT true,

  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- When they last proved who they were. Not "last did something".
  last_seen_at  timestamptz
);

CREATE UNIQUE INDEX app_user_email_key ON app_user (email);

COMMENT ON COLUMN app_user.email IS
  'The identity written into audit_log.actor and every created_by. Recorded at the time of the action, so renaming somebody later does not rewrite history.';

-- The system must never reach a state where nobody can administer it. Removing
-- the last owner is that state, and it is easier to do by accident than it
-- looks: deactivating one, or turning the flag off on one, while the other has
-- already gone.
CREATE OR REPLACE FUNCTION keep_one_owner() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_user WHERE is_owner AND is_active) THEN
    RAISE EXCEPTION 'LAST_OWNER: somebody has to be able to administer this — '
                    'make another user an owner first';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

-- DEFERRED is what makes this work, not the row-versus-statement distinction:
-- a CONSTRAINT TRIGGER in Postgres is always FOR EACH ROW. Because it fires at
-- COMMIT and asks a whole-table EXISTS, an UPDATE that demotes two owners in
-- one statement is still judged on the result — every row's check runs after
-- all of them have been applied. A BEFORE trigger would see the table as it
-- was and let the last owner go.
CREATE CONSTRAINT TRIGGER trg_keep_one_owner
  AFTER UPDATE OR DELETE ON app_user
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION keep_one_owner();

-- -----------------------------------------------------------------------------
-- 2. Sessions.
-- -----------------------------------------------------------------------------
CREATE TABLE user_session (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES app_user(id),

  -- THE COOKIE'S VALUE IS NEVER STORED. This is its SHA-256, so a copy of the
  -- database is not a set of working credentials — the same reason the password
  -- is not stored either. Whoever holds the raw token holds the session; that
  -- is what a session is.
  token_hash   text NOT NULL,

  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  -- Revoking rather than deleting, so "signed out everywhere on 3 September"
  -- is still answerable.
  revoked_at   timestamptz,
  -- What asked. Enough to recognise a session in a list, not a fingerprint.
  user_agent   text,

  CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX user_session_token_key ON user_session (token_hash);
CREATE INDEX user_session_user_idx ON user_session (user_id, created_at DESC);

COMMENT ON TABLE user_session IS
  'Proof of who is asking. The raw token lives only in the browser cookie; this holds its SHA-256.';
