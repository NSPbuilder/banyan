-- The period is the wall now.
--
-- The owner retired the post-freeze contract (docs/design/14-open-books.md):
-- a live entry may be edited or deleted while its period is OPEN, and a
-- closed period refuses everything — that was always the second wall, and it
-- is now the only one. Two things do not loosen:
--
--   * Raw SQL is still refused. Mutation is allowed only when the request
--     arrives through the application door — editEntry/deleteEntry set
--     `erp.open_edit` for their transaction (SET LOCAL), do the delta
--     rebalance and the audit write, and clear with the commit. A psql
--     session without the flag hits the same sentence it always did.
--   * A closed period is refused with no flag exception at all. amendEntry's
--     reverse-and-repost remains the only correction that touches one.
--
-- The flag is not a secret handshake for humans to type: it exists so the
-- guarantee "every mutation was rebalanced and audited" has a single door,
-- exactly like postEntry.

CREATE OR REPLACE FUNCTION entry_period_is_open(p_entry_id uuid) RETURNS boolean AS $$
  SELECT COALESCE(
    (SELECT fp.status = 'open'
       FROM journal_entry je JOIN fiscal_period fp ON fp.id = je.period_id
      WHERE je.id = p_entry_id),
    true)  -- a draft has no period yet; drafts were always editable
$$ LANGUAGE sql STABLE;

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
    -- The identity of the row holds even through the open door: the number
    -- was issued once, the ledger cannot change, and a live entry cannot be
    -- talked back into being a draft.
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

CREATE OR REPLACE FUNCTION forbid_posted_line_mutation() RETURNS trigger AS $$
DECLARE v_status text; v_id uuid; v_open_edit boolean;
BEGIN
  v_id := COALESCE(NEW.entry_id, OLD.entry_id);
  SELECT status INTO v_status FROM journal_entry WHERE id = v_id;
  -- NULL status = the parent entry is being cascade-deleted; allow.
  IF v_status IS NULL OR v_status = 'draft' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  v_open_edit := COALESCE(current_setting('erp.open_edit', true), '') = 'on';
  IF NOT v_open_edit THEN
    RAISE EXCEPTION 'Lines of journal entry % can only be changed through the application', v_id;
  END IF;
  IF NOT entry_period_is_open(v_id) THEN
    RAISE EXCEPTION 'PERIOD_CLOSED: journal entry % sits in a closed period; reopen the period or correct it with a reversal', v_id;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
