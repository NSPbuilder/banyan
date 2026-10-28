-- 0021 — a reversed entry cannot still settle a bank row
--
-- Why: docs/design/07-bank-matching.md §3b.
--
-- 0020 checked the entry's status when a match was CREATED and never again.
-- Reversing an entry afterwards left the match in place, so the bank row went on
-- reporting itself accounted for by an entry that had been unwound. Amending was
-- worse: the match stayed on the reversed original, the replacement carrying the
-- money was claimed by nothing, and the replacement could not be matched because
-- the row already read as full. The correction was unreachable.
--
-- Deferred, because `amendEntry` reverses the original and posts the replacement
-- in one transaction and the matches move between those two statements.

CREATE OR REPLACE FUNCTION check_reversed_holds_no_match() RETURNS trigger AS $$
DECLARE stuck int;
BEGIN
  IF NEW.status <> 'reversed' THEN RETURN NULL; END IF;

  SELECT count(*) INTO stuck FROM bank_match m WHERE m.entry_id = NEW.id;
  IF stuck > 0 THEN
    RAISE EXCEPTION 'REVERSED_STILL_MATCHED: entry % settles % bank row(s); undo the match before reversing it',
      coalesce(NEW.entry_no, NEW.id::text), stuck;
  END IF;

  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_reversed_holds_no_match
  AFTER UPDATE ON journal_entry
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_reversed_holds_no_match();
