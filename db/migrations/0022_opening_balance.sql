-- 0022 — the opening balance is the earliest thing in the ledger
--
-- Why: docs/design/08-opening-balances.md.
--
-- Two rules, both about the same idea: an opening balance is where the books
-- start, so there can only be one and nothing can come before it.

-- -----------------------------------------------------------------------------
-- 1. One live opening balance per ledger.
--
-- Partial on `status <> 'reversed'`, so a wrong one can be reversed and entered
-- again — which is the ordinary way of fixing anything posted here. The
-- reversal itself is `source_type = 'adjustment'` (reverseEntryCore sets it), so
-- it does not occupy the slot.
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX one_opening_balance_per_ledger
  ON journal_entry (ledger_id)
  WHERE source_type = 'opening_balance' AND status <> 'reversed';

-- -----------------------------------------------------------------------------
-- 2. Nothing may be dated before it.
--
-- An opening balance that is not the earliest entry is not opening anything: the
-- entries before it are movement against a starting position that did not exist
-- yet, and every statement over that range is a fiction. Both directions are the
-- same rule, so both are checked by the same function — entering an opening
-- balance after something older is already posted, and posting something older
-- once an opening balance exists.
--
-- Deferred: the two entries can be written in one transaction.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_opening_is_earliest() RETURNS trigger AS $$
DECLARE
  opening_date date;
  opening_no   text;
  earlier_no   text;
  earlier_date date;
BEGIN
  IF NEW.status = 'draft' THEN RETURN NULL; END IF;

  SELECT e.entry_date, e.entry_no INTO opening_date, opening_no
    FROM journal_entry e
   WHERE e.ledger_id = NEW.ledger_id
     AND e.source_type = 'opening_balance'
     AND e.status <> 'reversed'
   LIMIT 1;

  IF opening_date IS NULL THEN RETURN NULL; END IF;

  SELECT e.entry_no, e.entry_date INTO earlier_no, earlier_date
    FROM journal_entry e
   WHERE e.ledger_id = NEW.ledger_id
     AND e.status <> 'draft'
     AND e.source_type <> 'opening_balance'
     AND e.entry_date < opening_date
   ORDER BY e.entry_date
   LIMIT 1;

  IF earlier_no IS NOT NULL THEN
    RAISE EXCEPTION 'BEFORE_OPENING: entry % is dated % , before the opening balance % on %; the opening balance has to be the earliest thing in the books',
      earlier_no, earlier_date, coalesce(opening_no, '(unnumbered)'), opening_date;
  END IF;

  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_opening_is_earliest
  AFTER INSERT OR UPDATE ON journal_entry
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_opening_is_earliest();
