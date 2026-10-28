-- 0019 — the gapless check belongs on INSERT only
--
-- A BUG, not a wording change.
--
-- Deleting an unmatched bank row is a supported operation — 0017's own delete
-- guard permits it deliberately. Delete occurrence 1 of two identical rows and
-- occurrence 2 survives above a hole. The check then fired on every UPDATE of
-- that survivor, so it could never be marked matched or ignored again:
--
--   OCCURRENCE_GAP: a bank row numbered 2 has no 1 before it
--
-- raised while setting a status, and surfaced to the person as a sentence about
-- re-reading the import file. The row was permanently unreconcilable.
--
-- The UPDATE arm could never have been useful. `check_bank_row_immutable`
-- already refuses any change to account_id, txn_date, amount, description or
-- occurrence — every column this check reads. On UPDATE the answer therefore
-- cannot have changed since the INSERT, so the check can only ever repeat
-- itself or punish a row for a hole something else made.
--
-- On INSERT it is still load-bearing, and that is the whole of what it does.
--
-- The reasoning lives in docs/design/06-bank-csv.md §6, not here. Migrations are
-- append-only: an argument written into one cannot be corrected without another
-- migration, and this is the second one spent doing exactly that. Comments in
-- this directory say WHAT and point at where WHY is kept.

DROP TRIGGER trg_occurrence_gapless ON bank_transaction;

CREATE CONSTRAINT TRIGGER trg_occurrence_gapless
  AFTER INSERT ON bank_transaction
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_occurrence_gapless();
