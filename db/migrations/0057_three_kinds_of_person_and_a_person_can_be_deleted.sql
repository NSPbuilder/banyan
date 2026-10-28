-- 0057 — three kinds of person, and a person can be deleted
--
-- Why: docs/design/17-who-you-are.md §9 (owner, 2026-09-05). "Can administer"
-- becomes a TYPE with three values — superadmin, owner, user — and a person
-- can be deleted: a user by an owner, an owner by a superadmin.
--
-- The deferred keep-one trigger has to judge each statement here as it ends,
-- not at COMMIT: a table with pending trigger events cannot be ALTERed, and
-- the column it watches is about to be rebuilt.
SET CONSTRAINTS ALL IMMEDIATE;

-- -----------------------------------------------------------------------------
-- ONE. `kind`. `is_owner` stays — as a GENERATED column, kind <> 'user' — so
-- every gate that asks "may this person administer?" keeps its answer without
-- being touched. Only the rung above it is new.
-- -----------------------------------------------------------------------------
ALTER TABLE app_user
  ADD COLUMN kind text NOT NULL DEFAULT 'user'
    CONSTRAINT app_user_kind_check CHECK (kind IN ('superadmin', 'owner', 'user'));

UPDATE app_user SET kind = 'owner' WHERE is_owner;

-- The first owner ever made is the superadmin. Somebody has to be able to
-- manage owners from the first minute, and the account that set the system
-- up is the only defensible choice; the others stay owners.
UPDATE app_user SET kind = 'superadmin'
 WHERE id = (SELECT id FROM app_user WHERE is_owner ORDER BY created_at, id LIMIT 1);

ALTER TABLE app_user DROP COLUMN is_owner;
ALTER TABLE app_user
  ADD COLUMN is_owner boolean GENERATED ALWAYS AS (kind <> 'user') STORED;

COMMENT ON COLUMN app_user.kind IS
  'superadmin, owner or user. A superadmin manages everybody; an owner manages users; '
  'a user sees what user_entity_access and user_module_access grant. The first owner '
  'created became the superadmin in 0057.';
COMMENT ON COLUMN app_user.is_owner IS
  'Derived: kind <> ''user''. May administer — manage people, take backups. Read by every '
  'gate; written by nobody since 0057.';

-- -----------------------------------------------------------------------------
-- TWO. The guard moves up a rung: the system must never be left without an
-- ACTIVE SUPERADMIN (0053 said owner). Same trigger, same deferral, new body.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION keep_one_owner() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_user WHERE kind = 'superadmin' AND is_active) THEN
    RAISE EXCEPTION 'LAST_SUPERADMIN: somebody has to be able to administer this — '
                    'make another user a superadmin first';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

-- -----------------------------------------------------------------------------
-- THREE. Deleting. 0053 said a person is never deleted; the owner overrides
-- that. What names a person on every row is their EMAIL as text — created_by,
-- audit_log.actor — not a key to this table, so history keeps its names after
-- the account goes. What does hang off the account by key is theirs alone:
-- sessions and grants. The grants already cascade (0054); the sessions did not.
-- -----------------------------------------------------------------------------
ALTER TABLE user_session
  DROP CONSTRAINT user_session_user_id_fkey,
  ADD CONSTRAINT user_session_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES app_user(id) ON DELETE CASCADE;
