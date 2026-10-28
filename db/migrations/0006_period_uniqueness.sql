-- =============================================================================
-- 0006 — a date must map to exactly ONE period.
--
-- Nothing stopped a second open period from covering dates already inside a
-- closed one. Creating a period is ordinary administration, not misuse, so
-- this was a bypass available without any special privilege: open a period
-- "2026-ADJ" spanning 15-31 January, file a 20 January entry under it, and
-- $44,444 landed in closed January with both integrity checks silent, because
-- the entry's date really did sit inside the period it was filed under.
--
-- Also: fiscal_year.status was never read. A locked year with an open period
-- still accepted postings.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Periods within a ledger may not overlap. This is what makes "the period for
-- this date" a well-defined question — for the trigger, for postEntry's lookup,
-- and for every report.
--
-- It also retires the "13 = year-end adjustments" idea in 0001: an adjustment
-- period cannot overlap period 12, so year-end adjustments are dated inside the
-- last period like any other entry.
ALTER TABLE fiscal_period ADD CONSTRAINT fiscal_period_no_overlap
  EXCLUDE USING gist (
    ledger_id WITH =,
    daterange(start_date, end_date, '[]') WITH &&
  );

COMMENT ON CONSTRAINT fiscal_period_no_overlap ON fiscal_period IS
  'A date maps to exactly one period. Without this, an open period overlapping a closed one is a way to post into closed figures.';

-- The year's status counts too. A locked year cannot receive postings even
-- through a period someone left open.
CREATE OR REPLACE FUNCTION assert_period_open() RETURNS trigger AS $$
DECLARE p RECORD;
BEGIN
  IF NEW.status NOT IN ('posted', 'reversed') THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status IN ('posted', 'reversed') THEN RETURN NEW; END IF;

  SELECT fp.status, fp.name, fp.ledger_id, fp.start_date, fp.end_date,
         fy.status AS year_status, fy.name AS year_name
    INTO p
    FROM fiscal_period fp
    JOIN fiscal_year fy ON fy.id = fp.fiscal_year_id
   WHERE fp.id = NEW.period_id;

  IF p IS NULL THEN
    RAISE EXCEPTION 'No fiscal period covers % in this ledger', NEW.entry_date;
  END IF;
  IF p.ledger_id <> NEW.ledger_id THEN
    RAISE EXCEPTION 'Period % belongs to a different ledger than entry %', p.name, NEW.id;
  END IF;
  IF NEW.entry_date < p.start_date OR NEW.entry_date > p.end_date THEN
    RAISE EXCEPTION 'Entry dated % cannot be filed under period % (% to %)',
      NEW.entry_date, p.name, p.start_date, p.end_date;
  END IF;
  IF p.year_status <> 'open' THEN
    RAISE EXCEPTION 'Fiscal year % is % — cannot post entry dated %',
      p.year_name, p.year_status, NEW.entry_date;
  END IF;
  IF p.status <> 'open' THEN
    RAISE EXCEPTION 'Fiscal period is % — cannot post entry dated %', p.status, NEW.entry_date;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
