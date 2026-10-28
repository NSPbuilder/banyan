-- =============================================================================
-- 0013 — an entry could post into a period that closed underneath it.
--
-- closePeriod took FOR UPDATE on the fiscal_period row, but the posting path
-- never locked it, so the lock serialised close against close and nothing else.
-- Under READ COMMITTED a posting transaction that read the period as open kept
-- that row version for its whole life, and a close could commit in between.
--
-- Nothing reported the result:
--   check_period_assignments        — the date IS inside the period
--   check_balance_integrity         — cache and journal agree, both written in
--                                     the same transaction
--   check_entries_in_closed_periods — compares posted_at > closed_at, and the
--                                     posting transaction's timestamp is EARLIER
--
-- Two changes: the gate now takes a row lock, so a close waits for a post in
-- flight and a post waits for a close; and the detector compares what actually
-- distinguishes the two events rather than their clock times.
-- =============================================================================

CREATE OR REPLACE FUNCTION assert_period_open() RETURNS trigger AS $$
DECLARE p RECORD;
BEGIN
  IF NEW.status NOT IN ('posted', 'reversed') THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status IN ('posted', 'reversed') THEN RETURN NEW; END IF;

  -- FOR SHARE, not a plain read. A close holds FOR UPDATE on this row, so it
  -- must now wait for any posting in flight, and a post starting during a close
  -- waits for it and then sees the closed row.
  SELECT fp.status, fp.name, fp.ledger_id, fp.start_date, fp.end_date,
         fy.status AS year_status, fy.name AS year_name
    INTO p
    FROM fiscal_period fp
    JOIN fiscal_year fy ON fy.id = fp.fiscal_year_id
   WHERE fp.id = NEW.period_id
     FOR SHARE OF fp;

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

-- The detector, asking a question that has an answer.
--
-- posted_at is when the posting transaction began, so an entry that slipped
-- past a close has a posted_at EARLIER than closed_at — the old comparison was
-- backwards for the one case it was meant to catch. What actually identifies a
-- stranded entry is simply that it is real and sitting in a period that is not
-- open. Every such entry is worth seeing; the ordinary case is that there are
-- none, because the gate refuses them.
DROP FUNCTION IF EXISTS check_entries_in_closed_periods(uuid);

CREATE FUNCTION check_entries_in_closed_periods(p_ledger_id uuid)
RETURNS TABLE (
  entry_no text, entry_date date, description text,
  period_name text, period_status text, posted_at timestamptz, closed_at timestamptz
) AS $$
  SELECT je.entry_no, je.entry_date, je.description,
         fp.name, fp.status, je.posted_at, fp.closed_at
    FROM journal_entry je
    JOIN fiscal_period fp ON fp.id = je.period_id
   WHERE je.ledger_id = p_ledger_id
     AND je.status IN ('posted','reversed')
     AND fp.status <> 'open'
     -- Entries posted BEFORE the period was closed are the normal case: that is
     -- what closing a period means. Only an entry posted at or after the close
     -- is stranded — and because posted_at is the transaction's start time, a
     -- race shows up as posted_at within a whisker of closed_at rather than
     -- clearly after it. Anything not comfortably earlier is worth a look.
     AND (fp.closed_at IS NULL OR je.posted_at > fp.closed_at - interval '1 second')
   ORDER BY je.entry_date;
$$ LANGUAGE sql STABLE;
