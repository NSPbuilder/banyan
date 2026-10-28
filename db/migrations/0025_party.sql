-- 0025 — customers and suppliers are one list, and the ledger points at it
--
-- Why: docs/design/03-parties.md, 「One party, many roles」 and the sections
-- under it. That shape was frozen on 2026-08-22, before any of this existed,
-- because it is expensive to change once invoices reference it. This file
-- implements it and does not re-argue it.
--
-- The short version, so this file is readable on its own: ONE list of
-- organisations and people, global across the companies; roles are per company,
-- so Acme can be a customer of one and a supplier of another; a journal line
-- points at a party, and every "what do they owe" question is derived from the
-- ledger rather than kept in a second balance table beside it.

-- -----------------------------------------------------------------------------
-- 1. The roles a party can hold.
--
-- A reference table rather than a CHECK, for the reason `accounting_standard`
-- is one: adding a role later should be an INSERT, not a migration. 'director'
-- and 'shareholder' are here because P4 (BC corporate records) needs exactly
-- these people and it would be strange to store them somewhere else.
-- -----------------------------------------------------------------------------
CREATE TABLE party_role_definition (
  code        text PRIMARY KEY,
  label       text NOT NULL,
  -- Roles that carry money into the ledger. A journal line may only name a
  -- party who holds a TRANSACTING role in that company — see rule 5.
  transacts   boolean NOT NULL DEFAULT false,
  sort_order  int NOT NULL DEFAULT 0
);
INSERT INTO party_role_definition (code, label, transacts, sort_order) VALUES
  ('customer',    'Customer',    true,  10),
  ('supplier',    'Supplier',    true,  20),
  ('employee',    'Employee',    true,  30),
  ('director',    'Director',    false, 40),
  ('shareholder', 'Shareholder', false, 50);

-- -----------------------------------------------------------------------------
-- 2. The party itself. Global — no entity_id.
--
-- Bell Canada is one organisation whether it invoices one company or three, and
-- the whole point of this table is that its address is changed in one place.
-- `03` leaves open an optional entity_id for a party only one company deals
-- with; not done, because nothing needs it yet and an optional scope is a
-- second answer to "which parties are there".
-- -----------------------------------------------------------------------------
CREATE TABLE party (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL CHECK (kind IN ('organisation', 'person')),

  -- The legal name — what goes on an invoice and in the corporate records.
  name          text NOT NULL CHECK (length(trim(name)) > 0),
  -- What they are actually called, when that differs.
  trading_name  text,

  -- GST/HST or BN. Not validated here: the format is a jurisdiction question
  -- and this table is not the place to decide it.
  tax_number    text,

  is_active     boolean NOT NULL DEFAULT true,
  notes         text,

  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text NOT NULL DEFAULT 'system',
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- The same organisation entered twice under the same name is the duplicate that
-- actually happens, and `03` asks for a check rather than a fuzzy matcher. This
-- is that check: normalised name, active parties only, so a deliberate second
-- record is possible by deactivating the first.
--
-- It does NOT catch "Bell Canada" against "Bell Canada Inc.". Nothing here
-- pretends to. A matcher that guesses would be a third answer to "who are they".
CREATE UNIQUE INDEX party_one_active_name
  ON party (lower(regexp_replace(trim(name), '\s+', ' ', 'g')))
  WHERE is_active;

-- -----------------------------------------------------------------------------
-- 3. Roles, per company, with the dates they were held.
--
-- Dates because a director resigns and a supplier stops being one, and P4 has
-- to export "the directors as at 30 June" and get the people who were directors
-- then. A role held twice over two separate stretches is ordinary; two
-- overlapping rows for the same role are not.
-- -----------------------------------------------------------------------------
CREATE TABLE party_role (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  party_id   uuid NOT NULL REFERENCES party(id) ON DELETE CASCADE,
  entity_id  uuid NOT NULL REFERENCES entity(id),
  role       text NOT NULL REFERENCES party_role_definition(code),

  held_from  date NOT NULL,
  held_to    date,

  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL DEFAULT 'system',

  CHECK (held_to IS NULL OR held_to >= held_from)
);
CREATE INDEX party_role_lookup ON party_role (entity_id, role, held_from);
CREATE INDEX party_role_party  ON party_role (party_id);

CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE party_role ADD CONSTRAINT party_role_no_overlap
  EXCLUDE USING gist (
    party_id  WITH =,
    entity_id WITH =,
    role      WITH =,
    daterange(held_from, COALESCE(held_to, 'infinity'::date), '[]') WITH &&
  );

-- -----------------------------------------------------------------------------
-- 4. Addresses and contacts. Hang off the party, so changing one changes it
--    everywhere — which is the acceptance test `03` was written against.
-- -----------------------------------------------------------------------------
CREATE TABLE party_address_purpose (
  code       text PRIMARY KEY,
  label      text NOT NULL,
  sort_order int NOT NULL DEFAULT 0
);
INSERT INTO party_address_purpose (code, label, sort_order) VALUES
  ('registered', 'Registered office', 10),
  ('records',    'Records office',    20),
  ('mailing',    'Mailing',           30),
  ('delivery',   'Delivery',          40);

CREATE TABLE party_address (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  party_id    uuid NOT NULL REFERENCES party(id) ON DELETE CASCADE,
  purpose     text NOT NULL REFERENCES party_address_purpose(code),

  line1       text NOT NULL CHECK (length(trim(line1)) > 0),
  line2       text,
  city        text,
  region      text,                      -- province or state
  postal_code text,
  country     text NOT NULL DEFAULT 'CA',

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  -- One address per purpose. Two "registered office" rows is two answers to a
  -- question the BC registry asks in the singular.
  UNIQUE (party_id, purpose)
);

CREATE TABLE party_contact (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  party_id   uuid NOT NULL REFERENCES party(id) ON DELETE CASCADE,
  name       text,
  email      text,
  phone      text,
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),

  -- A contact with nothing in it is a row that looks like information.
  CHECK (COALESCE(name, email, phone) IS NOT NULL)
);
CREATE INDEX party_contact_party ON party_contact (party_id);

-- At most one primary contact per party.
CREATE UNIQUE INDEX party_one_primary_contact
  ON party_contact (party_id) WHERE is_primary;

-- -----------------------------------------------------------------------------
-- 5. The ledger points at a party.
--
-- A column, not a dimension: `03` settled that, because aging filters on it
-- constantly and dimensions are jsonb.
-- -----------------------------------------------------------------------------
ALTER TABLE journal_line ADD COLUMN party_id uuid REFERENCES party(id);
CREATE INDEX journal_line_party_idx ON journal_line (party_id) WHERE party_id IS NOT NULL;

-- A line may only name a party who holds a transacting role in the company
-- whose books the line is in, on the day of the entry.
--
-- Without this, `party_id` is a free-text tag: nothing would stop a receivable
-- being booked against a director who has never been a customer, and the aging
-- would then show a debt owed by someone with no relationship to the company.
-- The date matters too — a supplier relationship that ended in March cannot
-- explain an invoice dated in June.
CREATE OR REPLACE FUNCTION check_line_party() RETURNS trigger AS $$
DECLARE
  line_entity uuid;
  line_date   date;
  party_name  text;
BEGIN
  IF NEW.party_id IS NULL THEN RETURN NEW; END IF;

  SELECT l.entity_id, e.entry_date INTO line_entity, line_date
    FROM journal_entry e JOIN ledger l ON l.id = e.ledger_id
   WHERE e.id = NEW.entry_id;

  IF NOT EXISTS (
    SELECT 1 FROM party_role pr
      JOIN party_role_definition d ON d.code = pr.role
     WHERE pr.party_id = NEW.party_id
       AND pr.entity_id = line_entity
       AND d.transacts
       AND pr.held_from <= line_date
       AND (pr.held_to IS NULL OR pr.held_to >= line_date))
  THEN
    SELECT name INTO party_name FROM party WHERE id = NEW.party_id;
    RAISE EXCEPTION 'PARTY_NOT_TRADING: % is not a customer, supplier or employee of this company on %',
      COALESCE(party_name, NEW.party_id::text), line_date;
  END IF;

  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_line_party
  AFTER INSERT ON journal_line
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_line_party();

-- -----------------------------------------------------------------------------
-- 6. A party that the books refer to cannot be deleted.
--
-- Same rule as `account`, for the same reason: deleting it would leave journal
-- lines pointing at nothing, and the history of who was owed what would be gone
-- while the ledger still balanced. Deactivate instead.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_party_delete() RETURNS trigger AS $$
DECLARE
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM journal_line WHERE party_id = OLD.id;
  IF n > 0 THEN
    RAISE EXCEPTION 'PARTY_IN_USE: % is named on % journal line%; it cannot be deleted. Deactivate it instead.',
      OLD.name, n, CASE WHEN n = 1 THEN '' ELSE 's' END;
  END IF;
  RETURN OLD;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_party_delete
  BEFORE DELETE ON party
  FOR EACH ROW EXECUTE FUNCTION check_party_delete();

-- -----------------------------------------------------------------------------
-- 7. Who someone is, and when they stopped being it, is worth a record.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION log_party_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO audit_log (actor, action, table_name, record_id, after, context)
    VALUES (NEW.created_by, 'create_party', 'party', NEW.id::text,
            jsonb_build_object('name', NEW.name, 'kind', NEW.kind),
            jsonb_build_object('tax_number', NEW.tax_number));
    RETURN NEW;
  END IF;

  IF NEW.name IS DISTINCT FROM OLD.name
     OR NEW.is_active IS DISTINCT FROM OLD.is_active
     OR NEW.tax_number IS DISTINCT FROM OLD.tax_number THEN
    INSERT INTO audit_log (actor, action, table_name, record_id, before, after)
    VALUES (current_user, 'update_party', 'party', NEW.id::text,
            jsonb_build_object('name', OLD.name, 'is_active', OLD.is_active,
                               'tax_number', OLD.tax_number),
            jsonb_build_object('name', NEW.name, 'is_active', NEW.is_active,
                               'tax_number', NEW.tax_number));
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_party_audit
  AFTER INSERT OR UPDATE ON party
  FOR EACH ROW EXECUTE FUNCTION log_party_change();

CREATE OR REPLACE FUNCTION log_party_role_change() RETURNS trigger AS $$
BEGIN
  INSERT INTO audit_log (actor, action, table_name, record_id, after, context)
  VALUES (COALESCE(NEW.created_by, current_user),
          CASE WHEN TG_OP = 'INSERT' THEN 'grant_party_role' ELSE 'amend_party_role' END,
          'party_role', NEW.id::text,
          jsonb_build_object('role', NEW.role, 'held_from', NEW.held_from,
                             'held_to', NEW.held_to),
          jsonb_build_object('party_id', NEW.party_id, 'entity_id', NEW.entity_id));
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_party_role_audit
  AFTER INSERT OR UPDATE ON party_role
  FOR EACH ROW EXECUTE FUNCTION log_party_role_change();
