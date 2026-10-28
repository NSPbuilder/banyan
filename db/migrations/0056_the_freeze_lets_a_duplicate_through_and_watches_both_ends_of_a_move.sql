-- 0056 — the freeze lets a duplicate through, and watches both ends of a move
--
-- Why: docs/design/19-bank-feed-and-reconcile.md. Two corrections to 0055,
-- both found by a critic the same day, both in functions 0055 created; this
-- file replaces the functions and leaves 0055's text alone, because a migration
-- once applied is not edited (the migrator checksums it).
--
-- ONE. Next month's file overlaps this month's by a few days — 06 §6 treats
-- that as the ordinary case and numbers rows so the overlap recognises itself.
-- `importBankRows` lands them with ON CONFLICT DO NOTHING. But a BEFORE INSERT
-- trigger fires before the conflict is noticed, so 0055's freeze refused the
-- whole file the first time a period was finished, for rows that were
-- byte-identical no-ops. The freeze now lets a row through when an identical
-- row is already on file; the conflict clause then discards it as before.
--
-- TWO. A match can be MOVED between rows (UPDATE bank_match SET
-- bank_transaction_id). 0055 looked only at the row the match was moving TO —
-- `coalesce(NEW.…, OLD.…)` with a NOT NULL column always answers NEW — so a
-- match could be lifted OFF a finished period onto a later row, changing a
-- difference somebody had signed as zero. No application path moves a match
-- between rows today (amendEntry re-points entry_id, not the row), so this was
-- latent; it is closed anyway, because the header of 0055 said "moved" and
-- the trigger did not mean it.
--
-- And a correction to 0055's own comment, which cannot be edited: it says the
-- `trg_a_` prefix runs the freeze before the AUDIT trigger. The audit trigger
-- on bank_transaction is AFTER (0017), and AFTER triggers never run when a
-- BEFORE trigger raises, prefix or no prefix. What the prefix actually buys is
-- ordering among the BEFORE triggers — the freeze answers before the
-- immutability and delete guards, so the refusal names the freeze rather than
-- a rule that happens to sort first. Same rule as 06 §6: a migration's
-- reasoning is corrected in the design note, not in the migration.

CREATE OR REPLACE FUNCTION check_bank_row_frozen() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- An identical row already on file is the overlap 06 §6 designed for: it
    -- will be discarded by ON CONFLICT and changes nothing. Only a row that
    -- would actually land inside the freeze is refused.
    IF NOT EXISTS (SELECT 1 FROM bank_transaction t
                    WHERE t.account_id = NEW.account_id AND t.txn_date = NEW.txn_date
                      AND t.amount = NEW.amount AND t.description = NEW.description
                      AND t.occurrence = NEW.occurrence) THEN
      PERFORM refuse_if_frozen(NEW.account_id, NEW.txn_date, 'a row dated ' || NEW.txn_date);
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    PERFORM refuse_if_frozen(OLD.account_id, OLD.txn_date, 'the row of ' || OLD.txn_date);
    RETURN OLD;
  END IF;
  IF (NEW.ignored_at IS NULL) IS DISTINCT FROM (OLD.ignored_at IS NULL) THEN
    PERFORM refuse_if_frozen(OLD.account_id, OLD.txn_date, 'the row of ' || OLD.txn_date);
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION check_bank_match_frozen() RETURNS trigger AS $$
DECLARE b bank_transaction%ROWTYPE;
BEGIN
  -- The row the match is on now, or is moving to.
  IF TG_OP <> 'DELETE' THEN
    SELECT * INTO b FROM bank_transaction WHERE id = NEW.bank_transaction_id;
    IF FOUND THEN
      PERFORM refuse_if_frozen(b.account_id, b.txn_date, 'the match on the row of ' || b.txn_date);
    END IF;
  END IF;
  -- And the row it was on, when that is a different one or it is being undone.
  IF TG_OP <> 'INSERT' THEN
    SELECT * INTO b FROM bank_transaction WHERE id = OLD.bank_transaction_id;
    IF FOUND THEN
      PERFORM refuse_if_frozen(b.account_id, b.txn_date, 'the match on the row of ' || b.txn_date);
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
