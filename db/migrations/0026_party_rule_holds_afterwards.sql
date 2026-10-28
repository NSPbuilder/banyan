-- 0026 — the party rule has to keep being true, not just become true
--
-- Why: docs/design/03-parties.md, 「Built on 2026-08-27」 and the note under it
-- about what 0026 closed.
--
-- 0025 put the rule on INSERT: a journal line may only name a party who held a
-- transacting role at that company on the entry date. Adversarial review asked
-- the obvious next question — what happens AFTERWARDS — and found three ways
-- for an already-written line to end up naming a party who held no such role:
--
--   1. `endRole()` narrows the role. It is an exported function, not a hand
--      written UPDATE: end a supplier relationship in March and every invoice
--      posted to them in April is instantly outside it. Nothing looked again.
--   2. The role row is deleted outright. `journal_line.party_id` references
--      `party(id)`, not the role, so nothing objected.
--   3. A draft's `entry_date` is moved. 0010 froze `ledger_id` on a draft for
--      exactly this reason and named the shape — a check that was true when the
--      line was written and stops being true when the header moves — but the
--      party rule is date-dependent and `entry_date` was not frozen.
--
-- The invariant is a property of the data, so it is maintained on every path
-- that can break it rather than only on the one that creates it.

-- -----------------------------------------------------------------------------
-- 0. One normaliser, because two is one too many.
--
-- 0025's index keyed on `lower(regexp_replace(trim(name), '\s+', ' ', 'g'))`
-- and `createParty` looked up with the same expression — except that Postgres
-- `trim()` strips ASCII SPACE only, while the JavaScript `.trim()` applied to
-- the name first strips tabs too. A name pasted with a tab either side keyed as
-- ' acme ltd. ' in the index and was looked up as 'acme ltd.': neither layer
-- caught the duplicate, and the check that was supposed to prove they agreed
-- used a fixture made of spaces.
--
-- Collapse first, then trim. Both sides call this function, so there is no
-- second expression to drift.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION party_name_key(p_name text) RETURNS text AS $$
  SELECT trim(regexp_replace(lower(p_name), '\s+', ' ', 'g'));
$$ LANGUAGE sql IMMUTABLE;

DROP INDEX IF EXISTS party_one_active_name;
CREATE UNIQUE INDEX party_one_active_name
  ON party (party_name_key(name)) WHERE is_active;

-- -----------------------------------------------------------------------------
-- 1. The rule itself, once, so the three places that ask it cannot drift apart.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION party_may_transact(
  p_party uuid, p_entity uuid, p_on date
) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM party_role pr
      JOIN party_role_definition d ON d.code = pr.role
     WHERE pr.party_id = p_party
       AND pr.entity_id = p_entity
       AND d.transacts
       AND pr.held_from <= p_on
       AND (pr.held_to IS NULL OR pr.held_to >= p_on));
$$ LANGUAGE sql STABLE;

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

  IF NOT party_may_transact(NEW.party_id, line_entity, line_date) THEN
    SELECT name INTO party_name FROM party WHERE id = NEW.party_id;
    RAISE EXCEPTION 'PARTY_NOT_TRADING: % is not a customer, supplier or employee of this company on %',
      COALESCE(party_name, NEW.party_id::text), line_date;
  END IF;

  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- Also on UPDATE. A draft's lines are editable until it is posted, and
-- `forbid_posted_line_mutation` permits changing `party_id` while the entry is
-- a draft — so the one path that can rewrite the column was the one the guard
-- did not watch.
DROP TRIGGER IF EXISTS trg_line_party ON journal_line;
CREATE CONSTRAINT TRIGGER trg_line_party
  AFTER INSERT OR UPDATE ON journal_line
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_line_party();

-- -----------------------------------------------------------------------------
-- 2. A role cannot be narrowed or removed out from under the books.
--
-- Not "cannot be changed": ending a relationship is ordinary and has to stay
-- possible. What is refused is ending it BEFORE something already posted, which
-- is the same shape as reversing an entry that settles a bank row (0021) — the
-- record and the thing that depends on it have to move together or not at all.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_role_still_covers() RETURNS trigger AS $$
DECLARE
  orphan_date date;
  orphan_no   text;
  who         text;
BEGIN
  SELECT e.entry_date, e.entry_no INTO orphan_date, orphan_no
    FROM journal_line jl
    JOIN journal_entry e ON e.id = jl.entry_id
    JOIN ledger l ON l.id = e.ledger_id
   WHERE jl.party_id = OLD.party_id
     AND l.entity_id = OLD.entity_id
     -- Only lines this role was covering, and only where nothing else covers
     -- them now: a party holding both 'customer' and 'supplier' keeps its lines
     -- explained by the other role.
     AND e.entry_date BETWEEN OLD.held_from AND COALESCE(OLD.held_to, 'infinity'::date)
     AND NOT party_may_transact(
           OLD.party_id, OLD.entity_id, e.entry_date)
   ORDER BY e.entry_date
   LIMIT 1;

  IF orphan_date IS NOT NULL THEN
    SELECT name INTO who FROM party WHERE id = OLD.party_id;
    RAISE EXCEPTION 'ROLE_STILL_NEEDED: % is named on % dated %, which this role is what explains; end it on or after that date',
      COALESCE(who, OLD.party_id::text), COALESCE(orphan_no, 'a draft'), orphan_date;
  END IF;

  RETURN NULL;
END $$ LANGUAGE plpgsql;

-- AFTER, and deferred, so the new state is visible: the question is whether the
-- lines are still covered once the change has been applied, not whether they
-- were covered before it.
CREATE CONSTRAINT TRIGGER trg_role_still_covers
  AFTER UPDATE OR DELETE ON party_role
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_role_still_covers();

-- -----------------------------------------------------------------------------
-- 3. Moving a draft's date re-asks the question for its lines.
--
-- 0010 froze `ledger_id` on a draft because a line's account/entity check would
-- otherwise become false without anything looking. The party check is a check
-- about a DATE, and the date was never frozen — so rather than freezing it
-- (a draft's date is the thing most likely to want changing), the check runs
-- again on the lines when it moves.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION recheck_lines_on_date_change() RETURNS trigger AS $$
DECLARE
  bad_party uuid;
  who       text;
BEGIN
  IF NEW.entry_date IS NOT DISTINCT FROM OLD.entry_date THEN RETURN NULL; END IF;

  SELECT jl.party_id INTO bad_party
    FROM journal_line jl
    JOIN ledger l ON l.id = NEW.ledger_id
   WHERE jl.entry_id = NEW.id
     AND jl.party_id IS NOT NULL
     AND NOT party_may_transact(jl.party_id, l.entity_id, NEW.entry_date)
   LIMIT 1;

  IF bad_party IS NOT NULL THEN
    SELECT name INTO who FROM party WHERE id = bad_party;
    RAISE EXCEPTION 'PARTY_NOT_TRADING: % is not a customer, supplier or employee of this company on %',
      COALESCE(who, bad_party::text), NEW.entry_date;
  END IF;

  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_entry_date_rechecks_parties
  AFTER UPDATE ON journal_entry
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION recheck_lines_on_date_change();
