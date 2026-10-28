-- 0038 rebuilt forbid_posted_entry_mutation around the period wall and
-- DROPPED 0005's rule on the way: a draft could once again be UPDATEd
-- straight to 'reversed', skipping numbering, posting, and every check that
-- guards them. D6g caught it within the hour — the discrimination suite
-- reads the function's own source for the rule, and the rule was gone.
-- Append-only fix: the 0038 function again, with 0005's sentence back in.

CREATE OR REPLACE FUNCTION forbid_posted_entry_mutation() RETURNS trigger AS $$
DECLARE v_open_edit boolean;
BEGIN
  v_open_edit := COALESCE(current_setting('erp.open_edit', true), '') = 'on';

  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'draft' THEN
      RETURN OLD;
    END IF;
    IF NOT v_open_edit THEN
      RAISE EXCEPTION 'Cannot delete journal entry % outside the application — deleteEntry rebalances and audits; raw SQL does neither', OLD.id;
    END IF;
    IF NOT entry_period_is_open(OLD.id) THEN
      RAISE EXCEPTION 'PERIOD_CLOSED: journal entry % sits in a closed period; reopen the period or correct it with a reversal', OLD.id;
    END IF;
    RETURN OLD;
  END IF;

  -- 0005, verbatim in spirit: a draft may only become posted. Reversal is
  -- what happens to a posted entry; draft -> reversed is a way past every
  -- check that guards posting, open books or not.
  IF OLD.status = 'draft' AND NEW.status NOT IN ('draft', 'posted') THEN
    RAISE EXCEPTION 'Draft entry % cannot go straight to %; post it first', OLD.id, NEW.status;
  END IF;

  IF OLD.status IN ('posted','reversed') THEN
    IF NOT v_open_edit THEN
      IF  NEW.ledger_id    IS DISTINCT FROM OLD.ledger_id
       OR NEW.entry_no     IS DISTINCT FROM OLD.entry_no
       OR NEW.entry_date   IS DISTINCT FROM OLD.entry_date
       OR NEW.period_id    IS DISTINCT FROM OLD.period_id
       OR NEW.currency     IS DISTINCT FROM OLD.currency
       OR NEW.total_debit  IS DISTINCT FROM OLD.total_debit
       OR NEW.total_credit IS DISTINCT FROM OLD.total_credit
       OR NEW.source_type  IS DISTINCT FROM OLD.source_type
       OR NEW.posted_at    IS DISTINCT FROM OLD.posted_at THEN
        RAISE EXCEPTION 'Journal entry % can only be changed through the application — editEntry rebalances and audits; raw SQL does neither', OLD.id;
      END IF;
      IF NEW.status NOT IN ('posted','reversed') THEN
        RAISE EXCEPTION 'Posted journal entry % cannot return to %', OLD.id, NEW.status;
      END IF;
      RETURN NEW;
    END IF;

    IF NOT entry_period_is_open(OLD.id) THEN
      RAISE EXCEPTION 'PERIOD_CLOSED: journal entry % sits in a closed period; reopen the period or correct it with a reversal', OLD.id;
    END IF;
    IF  NEW.ledger_id IS DISTINCT FROM OLD.ledger_id
     OR NEW.entry_no  IS DISTINCT FROM OLD.entry_no THEN
      RAISE EXCEPTION 'Journal entry % keeps its ledger and its number even while editable', OLD.id;
    END IF;
    IF NEW.status NOT IN ('posted','reversed') THEN
      RAISE EXCEPTION 'Posted journal entry % cannot return to %', OLD.id, NEW.status;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
