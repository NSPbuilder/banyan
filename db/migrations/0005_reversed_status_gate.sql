-- =============================================================================
-- 0005 — the closed-period gate only ever looked at status='posted'.
--
-- 0004 added the date-inside-period and ledger-match checks, but left them
-- behind `IF NEW.status <> 'posted' THEN RETURN NEW`. Everything downstream —
-- rebuild_period_balances, all of check_balance_integrity, every report —
-- treats status IN ('posted','reversed') as truth. So an entry inserted as
-- 'draft' and then UPDATEd to 'reversed' carried real figures into a closed
-- period, and the Rebuild button then folded them into the filed numbers and
-- reported no drift.
--
-- Three changes, each closing one step of that path:
--   1. The gate applies to 'reversed' as well as 'posted'.
--   2. A draft cannot become 'reversed'. Reversal is something that happens to
--      a posted entry; there is no other legitimate route to that status.
--   3. A 'reversed' entry must carry a number, a period and a posting time,
--      exactly as a posted one must.
-- =============================================================================

-- 1 -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_period_open() RETURNS trigger AS $$
DECLARE p RECORD;
BEGIN
  -- Anything the rest of the system counts as real must pass this gate.
  IF NEW.status NOT IN ('posted', 'reversed') THEN RETURN NEW; END IF;

  -- Marking an already-real entry as reversed is linkage, not a new posting.
  IF TG_OP = 'UPDATE' AND OLD.status IN ('posted', 'reversed') THEN RETURN NEW; END IF;

  SELECT fp.status, fp.name, fp.ledger_id, fp.start_date, fp.end_date
    INTO p FROM fiscal_period fp WHERE fp.id = NEW.period_id;

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
  IF p.status <> 'open' THEN
    RAISE EXCEPTION 'Fiscal period is % — cannot post entry dated %', p.status, NEW.entry_date;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 2 -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION forbid_posted_entry_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'Cannot delete posted journal entry % — reverse it instead', OLD.id;
    END IF;
    RETURN OLD;
  END IF;

  -- A draft may only become posted. Reversal is what happens to a posted entry;
  -- allowing draft -> reversed was a way past every check that guards posting.
  IF OLD.status = 'draft' AND NEW.status NOT IN ('draft', 'posted') THEN
    RAISE EXCEPTION 'Draft entry % cannot go straight to %; post it first', OLD.id, NEW.status;
  END IF;

  IF OLD.status IN ('posted','reversed') THEN
    IF  NEW.ledger_id    IS DISTINCT FROM OLD.ledger_id
     OR NEW.entry_no     IS DISTINCT FROM OLD.entry_no
     OR NEW.entry_date   IS DISTINCT FROM OLD.entry_date
     OR NEW.period_id    IS DISTINCT FROM OLD.period_id
     OR NEW.currency     IS DISTINCT FROM OLD.currency
     OR NEW.total_debit  IS DISTINCT FROM OLD.total_debit
     OR NEW.total_credit IS DISTINCT FROM OLD.total_credit
     OR NEW.source_type  IS DISTINCT FROM OLD.source_type
     OR NEW.posted_at    IS DISTINCT FROM OLD.posted_at THEN
      RAISE EXCEPTION 'Posted journal entry % is immutable', OLD.id;
    END IF;
    IF NEW.status NOT IN ('posted','reversed') THEN
      RAISE EXCEPTION 'Posted journal entry % cannot return to %', OLD.id, NEW.status;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 3 -------------------------------------------------------------------------
ALTER TABLE journal_entry ADD CONSTRAINT journal_entry_reversed_complete
  CHECK (status <> 'reversed' OR (entry_no IS NOT NULL AND period_id IS NOT NULL AND posted_at IS NOT NULL));

-- 4 -------------------------------------------------------------------------
-- Report any real entry sitting in a closed or locked period. check (e) in
-- 0004 only caught entries dated outside their own period.
CREATE OR REPLACE FUNCTION check_entries_in_closed_periods(p_ledger_id uuid)
RETURNS TABLE (entry_no text, entry_date date, period_name text, period_status text) AS $$
  SELECT je.entry_no, je.entry_date, fp.name, fp.status
    FROM journal_entry je JOIN fiscal_period fp ON fp.id = je.period_id
   WHERE je.ledger_id = p_ledger_id AND je.status IN ('posted','reversed')
     AND fp.status <> 'open'
     AND je.posted_at > fp.closed_at;
$$ LANGUAGE sql STABLE;
