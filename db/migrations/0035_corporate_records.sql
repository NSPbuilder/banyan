-- 0035 — corporate records: what the company must keep, kept honestly
--
-- Why, and every statute reference: docs/design/05-corporate-records.md.
-- Sections, fields and deadlines live THERE and only there — this file does not
-- repeat section numbers, because a number copied twice is a number that rots
-- in one place when the Act changes.
--
-- The shapes are all borrowed from machinery this repository already trusts:
--
--   * registers are AS-OF: leaving is writing a date, never deleting a row —
--     the sales-tax registration pattern, EXCLUDE constraint included;
--   * the securities register is APPEND-ONLY EVENTS, a transfer is two rows in
--     one group netting to zero — the journal's shape, because a register that
--     edits a quantity in place has erased the details the Act asks for;
--   * identity belongs to `party`; what belongs here is the RELATIONSHIP and
--     the fields the Act hangs on it. The one deliberate exception is the
--     prescribed address, which freezes on the directorship row so that an
--     old register stays what it was when a person later moves house.

-- -----------------------------------------------------------------------------
-- 1. What kind of company, as data.
-- -----------------------------------------------------------------------------
CREATE TABLE company_type (
  code        text PRIMARY KEY,
  name        text NOT NULL
);
INSERT INTO company_type (code, name) VALUES
  ('limited',                'Limited company'),
  ('unlimited_liability',    'Unlimited liability company'),
  ('community_contribution', 'Community contribution company'),
  ('benefit',                'Benefit company');

CREATE TABLE company_profile (
  entity_id            uuid PRIMARY KEY REFERENCES entity(id),
  incorporation_number text,
  business_number      text,
  -- The recognition date. Both annual deadlines derive from it, which is why
  -- it is a column and the deadlines are not.
  recognition_date     date,
  company_type         text NOT NULL DEFAULT 'limited' REFERENCES company_type(code),
  home_jurisdiction    text NOT NULL DEFAULT 'BC',
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           text NOT NULL DEFAULT 'system'
);

-- -----------------------------------------------------------------------------
-- 2. The two offices. Both must be in BC; the Act says so, so the database does.
--
-- Two address KINDS per office — delivery and mailing — kept as separate
-- columns because the Act distinguishes them throughout and a merged column
-- cannot be unmerged.
-- -----------------------------------------------------------------------------
CREATE TABLE corporate_office (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id         uuid NOT NULL REFERENCES entity(id),
  office            text NOT NULL CHECK (office IN ('registered', 'records')),
  delivery_address  text NOT NULL,
  delivery_city     text NOT NULL,
  delivery_province text NOT NULL DEFAULT 'BC' CHECK (delivery_province = 'BC'),
  delivery_postal   text,
  mailing_address   text,
  mailing_city      text,
  mailing_province  text CHECK (mailing_province IS NULL OR mailing_province = 'BC'),
  mailing_postal    text,
  effective_from    date NOT NULL,
  effective_to      date,
  created_by        text NOT NULL,
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE corporate_office ADD CONSTRAINT corporate_office_no_overlap
  EXCLUDE USING gist (
    entity_id WITH =,
    office WITH =,
    daterange(effective_from, COALESCE(effective_to, 'infinity'::date), '[]') WITH &&
  );

-- -----------------------------------------------------------------------------
-- 3. Directors. A row per term; ceasing is a date. The prescribed addresses are
--    THIS ROW'S columns — seeded from the party when appointed, then frozen
--    apart, so a register as at 2024 still shows the 2024 address.
-- -----------------------------------------------------------------------------
CREATE TABLE directorship (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id           uuid NOT NULL REFERENCES entity(id),
  party_id            uuid NOT NULL REFERENCES party(id),
  prescribed_delivery text NOT NULL,
  prescribed_mailing  text,
  appointed_on        date NOT NULL,
  ceased_on           date,
  created_by          text NOT NULL,
  CHECK (ceased_on IS NULL OR ceased_on >= appointed_on)
);

ALTER TABLE directorship ADD CONSTRAINT directorship_no_overlap
  EXCLUDE USING gist (
    entity_id WITH =,
    party_id WITH =,
    daterange(appointed_on, COALESCE(ceased_on, 'infinity'::date), '[]') WITH &&
  );

-- Offices held (president, secretary, …): separate rows, because one person
-- holds several and the register wants each with its own dates.
CREATE TABLE officer_position (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id   uuid NOT NULL REFERENCES entity(id),
  party_id    uuid NOT NULL REFERENCES party(id),
  title       text NOT NULL,
  held_from   date NOT NULL,
  held_to     date,
  created_by  text NOT NULL,
  CHECK (held_to IS NULL OR held_to >= held_from)
);

-- -----------------------------------------------------------------------------
-- 4. The central securities register: classes, and append-only movements.
-- -----------------------------------------------------------------------------
CREATE TABLE share_class (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id  uuid NOT NULL REFERENCES entity(id),
  name       text NOT NULL,
  series     text,
  created_by text NOT NULL
);
CREATE UNIQUE INDEX share_class_unique
  ON share_class (entity_id, name, COALESCE(series, ''));

CREATE TABLE share_transaction (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  share_class_id uuid NOT NULL REFERENCES share_class(id),
  party_id       uuid NOT NULL REFERENCES party(id),
  on_date        date NOT NULL,
  -- Signed shares: what this row does to THIS holder's position.
  delta          bigint NOT NULL CHECK (delta <> 0),
  kind           text NOT NULL CHECK (kind IN ('issue', 'transfer_in', 'transfer_out', 'cancellation')),
  -- A transfer is two rows in one group; the group must net to zero.
  transfer_group uuid,
  details        text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     text NOT NULL,
  -- The sign is the kind's sign, stated once and enforced, not remembered.
  CHECK (CASE kind WHEN 'issue'        THEN delta > 0
                   WHEN 'transfer_in'  THEN delta > 0
                   WHEN 'transfer_out' THEN delta < 0
                   WHEN 'cancellation' THEN delta < 0 END),
  CHECK ((kind IN ('transfer_in', 'transfer_out')) = (transfer_group IS NOT NULL))
);
CREATE INDEX share_transaction_class_idx ON share_transaction (share_class_id, on_date);
CREATE INDEX share_transaction_party_idx ON share_transaction (party_id);

-- The register is append-only, exactly like the journal and for the same
-- reason: the Act wants the dates and details of every issue and transfer, and
-- editing a quantity in place is erasing a detail.
CREATE OR REPLACE FUNCTION forbid_share_transaction_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'SHARES_APPEND_ONLY: the securities register does not edit; record a correcting transaction';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_share_transaction_frozen
  BEFORE UPDATE OR DELETE ON share_transaction
  FOR EACH ROW EXECUTE FUNCTION forbid_share_transaction_change();

-- A transfer nets to zero within its group — the trial balance of shares.
-- Deferred, because the two rows arrive in one transaction.
CREATE OR REPLACE FUNCTION check_transfer_group() RETURNS trigger AS $$
DECLARE total bigint; classes int; days int;
BEGIN
  IF NEW.transfer_group IS NULL THEN RETURN NULL; END IF;

  SELECT COALESCE(SUM(delta), 0), COUNT(DISTINCT share_class_id), COUNT(DISTINCT on_date)
    INTO total, classes, days
    FROM share_transaction WHERE transfer_group = NEW.transfer_group;

  IF total <> 0 THEN
    RAISE EXCEPTION 'TRANSFER_UNBALANCED: the transfer group nets to % shares; a transfer moves shares, it does not mint them', total;
  END IF;
  IF classes <> 1 OR days <> 1 THEN
    RAISE EXCEPTION 'TRANSFER_MIXED: one transfer, one class, one day';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_transfer_group
  AFTER INSERT ON share_transaction
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_transfer_group();

-- Nobody's holding goes negative on any day. Checked over the affected
-- holder's whole history, because a backdated transfer can break the past
-- while every present-day total still looks right.
CREATE OR REPLACE FUNCTION check_holding_never_negative() RETURNS trigger AS $$
DECLARE bad record;
BEGIN
  FOR bad IN
    SELECT on_date, SUM(delta) OVER (ORDER BY on_date, created_at, id) AS running
      FROM share_transaction
     WHERE share_class_id = NEW.share_class_id AND party_id = NEW.party_id
  LOOP
    IF bad.running < 0 THEN
      RAISE EXCEPTION 'SHARES_OVERDRAWN: that holder would be at % shares on %; nobody transfers shares they do not hold',
        bad.running, bad.on_date;
    END IF;
  END LOOP;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_holding_never_negative
  AFTER INSERT ON share_transaction
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_holding_never_negative();

-- -----------------------------------------------------------------------------
-- 5. The transparency register. The most sensitive table in the system —
--    birth dates, home addresses, citizenships, tax residency. Who may see a
--    rendered register is the renderer's job; that the fields are marked at
--    all is THIS table's companion, `register_field_visibility`.
-- -----------------------------------------------------------------------------
CREATE TABLE significant_individual (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id          uuid NOT NULL REFERENCES entity(id),
  party_id           uuid NOT NULL REFERENCES party(id),
  birth_date         date,
  last_known_address text,
  citizen_or_pr      boolean NOT NULL DEFAULT true,
  -- Only when neither citizen nor permanent resident: every country.
  citizenships       text,
  tax_resident_ca    boolean NOT NULL DEFAULT true,
  how_control        text NOT NULL,
  became_on          date NOT NULL,
  ceased_on          date,
  created_by         text NOT NULL,
  CHECK (ceased_on IS NULL OR ceased_on >= became_on),
  CHECK (citizen_or_pr OR citizenships IS NOT NULL)
);

ALTER TABLE significant_individual ADD CONSTRAINT significant_individual_no_overlap
  EXCLUDE USING gist (
    entity_id WITH =,
    party_id WITH =,
    daterange(became_on, COALESCE(ceased_on, 'infinity'::date), '[]') WITH &&
  );

-- Which fields the public may ever see is DATA, because the law on this is
-- changing by regulation: the day it changes, a row changes, not a release.
CREATE TABLE register_field_visibility (
  register   text NOT NULL,
  field      text NOT NULL,
  visibility text NOT NULL CHECK (visibility IN ('public', 'private')),
  PRIMARY KEY (register, field)
);
INSERT INTO register_field_visibility (register, field, visibility) VALUES
  ('transparency', 'name',               'private'),
  ('transparency', 'birth_date',         'private'),
  ('transparency', 'last_known_address', 'private'),
  ('transparency', 'citizen_or_pr',      'private'),
  ('transparency', 'citizenships',       'private'),
  ('transparency', 'tax_resident_ca',    'private'),
  ('transparency', 'how_control',        'private'),
  ('transparency', 'became_on',          'private'),
  ('directors',    'name',               'public'),
  ('directors',    'prescribed_delivery','public'),
  ('directors',    'appointed_on',       'public'),
  ('directors',    'ceased_on',          'public'),
  ('central_securities', 'name',         'private'),
  ('central_securities', 'holding',      'private');

-- -----------------------------------------------------------------------------
-- 6. The minute book: metadata about records, wherever the records live.
--    The text of a resolution is a document, not a schema; what the database
--    holds is that it exists, what kind it is, when, and where it is kept.
-- -----------------------------------------------------------------------------
CREATE TABLE minute_book_entry (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id   uuid NOT NULL REFERENCES entity(id),
  record_kind text NOT NULL CHECK (record_kind IN (
    'certificate', 'court_or_regulator_order', 'directors_consent',
    'resignation', 'shareholders_minutes', 'shareholders_resolution',
    'directors_minutes', 'directors_resolution', 'written_dissent',
    'financial_statements', 'articles', 'other')),
  on_date     date NOT NULL,
  title       text NOT NULL,
  kept_at     text NOT NULL,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text NOT NULL
);
CREATE INDEX minute_book_entity_idx ON minute_book_entry (entity_id, on_date);

-- -----------------------------------------------------------------------------
-- 7. Every register change is worth a record.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION log_corporate_record_change() RETURNS trigger AS $$
BEGIN
  INSERT INTO audit_log (actor, action, table_name, record_id, after)
  VALUES (COALESCE(NEW.created_by, 'system'),
          'record_' || TG_TABLE_NAME, TG_TABLE_NAME,
          NEW.id::text, to_jsonb(NEW) - 'birth_date' - 'last_known_address' - 'citizenships');
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_directorship_audit
  AFTER INSERT ON directorship
  FOR EACH ROW EXECUTE FUNCTION log_corporate_record_change();
CREATE TRIGGER trg_share_transaction_audit
  AFTER INSERT ON share_transaction
  FOR EACH ROW EXECUTE FUNCTION log_corporate_record_change();
CREATE TRIGGER trg_significant_individual_audit
  AFTER INSERT ON significant_individual
  FOR EACH ROW EXECUTE FUNCTION log_corporate_record_change();
CREATE TRIGGER trg_minute_book_audit
  AFTER INSERT ON minute_book_entry
  FOR EACH ROW EXECUTE FUNCTION log_corporate_record_change();
