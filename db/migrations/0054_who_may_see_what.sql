-- 0054 — who may see what
--
-- 0053 answered "who are you". RISKS §15b said what it still did not answer:
-- "which companies may you see" and "which parts of them", and that this
-- application is multi-entity by design — a bookkeeper who does the books for
-- one company has no business in another.
--
-- The owner asked for the module half (2026-09-04). BOTH halves are here,
-- because the company half is the one that actually protects the books: a
-- permission system that says "you may not open Payroll" while leaving every
-- company's ledger reachable has moved the lock without locking anything.
--
-- WHAT A MODULE IS. The seats in `src/lib/nav.ts` — the list that already IS
-- the definition of what this application is, that `N1` and `N2` pin against
-- the route tree. A second list of module names here would be the two-lists
-- defect: the day a module is added, the rail would show it and the permission
-- screen would not. So the module column holds a nav PATH ('/payroll',
-- '/records'), and a check requires every value to be a real seat.
--
-- WHAT THIS IS NOT. It is not per-(company, module): "payroll for company A but
-- not company B" is a distinction nobody here has needed, and inventing it
-- would triple the rows and the screen for a case that does not exist. Adding
-- it later is a column on `user_module_access`, not a redesign.
--
-- AN OWNER IS EXEMPT. `is_owner` already means "can manage people and take
-- backups"; it now also means "sees everything". A system where the
-- administrator can lock themselves out of a company is a system with a support
-- call and no support.

-- -----------------------------------------------------------------------------
-- 1. A person has a first name and a last name.
-- -----------------------------------------------------------------------------
-- One free-text `display_name` could not answer "what is their surname", which
-- a T4, an ROE and an ordinary letter all ask for. Two columns, and the
-- displayed name is DERIVED from them — a stored third copy would drift the
-- first time somebody was renamed.
ALTER TABLE app_user ADD COLUMN first_name text;
ALTER TABLE app_user ADD COLUMN last_name  text;

-- Split what is there on the first space: "Alicio Chen" becomes Alicio + Chen,
-- and a single word becomes a first name with no surname, which is the honest
-- reading of a field that never asked for one.
UPDATE app_user
   SET first_name = COALESCE(NULLIF(split_part(display_name, ' ', 1), ''), display_name),
       last_name  = NULLIF(substring(display_name from position(' ' in display_name) + 1), '')
 WHERE position(' ' in display_name) > 0;
UPDATE app_user
   SET first_name = display_name
 WHERE first_name IS NULL;

-- 0053's last-owner guard is a DEFERRED constraint trigger, so the two UPDATEs
-- above queue trigger events that are not settled until commit — and Postgres
-- refuses to ALTER a table with pending ones. Flushing them here runs that
-- check now, which is also the right moment: if this migration were somehow
-- leaving nobody able to administer, it should fail on that line and not on a
-- confusing ALTER further down.
SET CONSTRAINTS ALL IMMEDIATE;

ALTER TABLE app_user ALTER COLUMN first_name SET NOT NULL;
ALTER TABLE app_user ADD CONSTRAINT app_user_first_name_check
  CHECK (length(trim(first_name)) > 0);
ALTER TABLE app_user ADD CONSTRAINT app_user_last_name_check
  CHECK (last_name IS NULL OR length(trim(last_name)) > 0);
ALTER TABLE app_user DROP COLUMN display_name;

COMMENT ON COLUMN app_user.last_name IS
  'Nullable: some people have one name. Required by no form here, asked for by every one.';

-- -----------------------------------------------------------------------------
-- 2. Which companies a person may see.
-- -----------------------------------------------------------------------------
CREATE TABLE user_entity_access (
  user_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  entity_id  uuid NOT NULL REFERENCES entity(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  granted_by text NOT NULL,
  PRIMARY KEY (user_id, entity_id)
);

-- -----------------------------------------------------------------------------
-- 3. Which modules.
-- -----------------------------------------------------------------------------
CREATE TABLE user_module_access (
  user_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  -- A nav seat's path: '' for the overview, '/payroll', '/records'. Not a name
  -- of this table's own invention — `US20` requires every stored value to be a
  -- seat that exists in nav.ts.
  module     text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  granted_by text NOT NULL,
  PRIMARY KEY (user_id, module)
);

COMMENT ON TABLE user_module_access IS
  'Nav seat paths from src/lib/nav.ts. An owner is not listed here and sees everything.';

-- A grant that nobody can act on is a grant that lies to whoever made it: it
-- shows on the screen, and the person still cannot open the company. Access to
-- a module means nothing without a company to use it in.
CREATE OR REPLACE FUNCTION module_needs_a_company() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_user u
                  WHERE u.id = NEW.user_id AND u.is_owner)
     AND NOT EXISTS (SELECT 1 FROM user_entity_access a WHERE a.user_id = NEW.user_id)
  THEN
    RAISE EXCEPTION 'NO_COMPANY_YET: give this person a company before a module — '
                    'a module they cannot reach any books through does nothing';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_module_needs_a_company
  BEFORE INSERT ON user_module_access
  FOR EACH ROW EXECUTE FUNCTION module_needs_a_company();
