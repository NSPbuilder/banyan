-- 0055 — a finished reconciliation freezes what it covered
--
-- Why: docs/design/19-bank-feed-and-reconcile.md.
--
-- 0043 stored the bank's assertion — a date and the printed ending balance —
-- and everything on the report was derived. What it did not store was the one
-- thing a person DECIDES: that this statement is finished, the difference is
-- zero, and the rows and matches up to that date are not to be touched again.
-- QuickBooks calls it "Finish now" and marks the transactions R. Here it is a
-- pair of columns on the statement, in the same shape as a row's ignore
-- decision: a decision is stored; whether the difference IS zero is not, it is
-- computed — by one function, which both the guard and the screen call.
--
-- WHAT IS FROZEN. Everything dated on or before the newest finished statement
-- for that account: bank rows cannot be inserted, deleted, set aside or put
-- back; matches cannot be made, moved or undone; statements cannot be inserted
-- behind it or deleted. Any of those would change a difference that somebody
-- has signed as zero. Undo the reconciliation first — only the newest one,
-- because the one before it is what the newest one's beginning balance rests on.

-- -----------------------------------------------------------------------------
-- 1. The decision.
-- -----------------------------------------------------------------------------
ALTER TABLE bank_statement
  ADD COLUMN reconciled_at timestamptz,
  ADD COLUMN reconciled_by text;

ALTER TABLE bank_statement ADD CONSTRAINT bank_statement_reconciled CHECK (
  (reconciled_at IS NULL) = (reconciled_by IS NULL));

COMMENT ON COLUMN bank_statement.reconciled_at IS
  'Set by Finish, cleared by Undo. Not a derivation: the difference being zero is computed by bank_statement_difference().';

-- -----------------------------------------------------------------------------
-- 2. The difference, computed in ONE place.
--
--   beginning  = the prior statement's printed ending balance (or 0)
--   cleared    = beginning + every match on every row in (prior, this]
--   difference = this statement's printed ending − cleared
--
-- Which is also  import gap + the unmatched part of every row in the period,
-- ignored rows included: a row set aside still moved the bank's balance, and
-- if nothing in the books accounts for it the two sides genuinely differ. Two
-- set-aside rows that net to zero balance; one on its own does not, and should
-- not.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION bank_statement_difference(statement_id uuid) RETURNS bigint AS $$
DECLARE
  s bank_statement%ROWTYPE;
  prior_date date;
  beginning bigint;
  cleared bigint;
BEGIN
  SELECT * INTO s FROM bank_statement WHERE id = statement_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT statement_date, ending_balance INTO prior_date, beginning
    FROM bank_statement
   WHERE account_id = s.account_id AND statement_date < s.statement_date
   ORDER BY statement_date DESC LIMIT 1;
  beginning := coalesce(beginning, 0);

  SELECT beginning + coalesce(sum(m.amount), 0) INTO cleared
    FROM bank_match m
    JOIN bank_transaction b ON b.id = m.bank_transaction_id
   WHERE b.account_id = s.account_id
     AND b.txn_date <= s.statement_date
     AND (prior_date IS NULL OR b.txn_date > prior_date);

  RETURN s.ending_balance - cleared;
END $$ LANGUAGE plpgsql STABLE;

-- -----------------------------------------------------------------------------
-- 3. How far an account is frozen: the newest finished statement's date.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION bank_frozen_through(acct uuid) RETURNS date AS $$
  SELECT max(statement_date) FROM bank_statement
   WHERE account_id = acct AND reconciled_at IS NOT NULL
$$ LANGUAGE sql STABLE;

-- -----------------------------------------------------------------------------
-- 4. Finishing and undoing, in order.
--
-- Finish: the difference must be zero, and every earlier statement must
-- already be finished — a reconciliation rests on the one before it. Undo:
-- only the newest finished one, for the same reason read backwards. Nothing
-- else on a statement may change: a typo in the printed figure is DELETE and
-- enter again, as 0043 decided.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_bank_statement_update() RETURNS trigger AS $$
DECLARE
  diff bigint;
  frozen date;
BEGIN
  IF NEW.account_id IS DISTINCT FROM OLD.account_id
  OR NEW.statement_date IS DISTINCT FROM OLD.statement_date
  OR NEW.ending_balance IS DISTINCT FROM OLD.ending_balance THEN
    RAISE EXCEPTION 'STATEMENT_IMMUTABLE: a statement is the bank''s assertion; delete it and enter it again';
  END IF;

  frozen := bank_frozen_through(OLD.account_id);

  IF NEW.reconciled_at IS NOT NULL AND OLD.reconciled_at IS NULL THEN
    diff := bank_statement_difference(NEW.id);
    IF diff <> 0 THEN
      RAISE EXCEPTION 'NOT_BALANCED: the statement of % differs from the books by % cents; nothing can be finished until that is zero',
        NEW.statement_date, diff;
    END IF;
    IF frozen IS NOT NULL AND NEW.statement_date <= frozen THEN
      RAISE EXCEPTION 'ALREADY_FINISHED: the account is reconciled through %', frozen;
    END IF;
    IF EXISTS (SELECT 1 FROM bank_statement
                WHERE account_id = NEW.account_id AND statement_date < NEW.statement_date
                  AND reconciled_at IS NULL) THEN
      RAISE EXCEPTION 'EARLIER_OPEN: an earlier statement of this account is not finished; reconciliations are finished in order';
    END IF;
  END IF;

  IF NEW.reconciled_at IS NULL AND OLD.reconciled_at IS NOT NULL THEN
    IF OLD.statement_date <> frozen THEN
      RAISE EXCEPTION 'NOT_THE_NEWEST: only the newest finished reconciliation (%) can be undone; the ones after this rest on it',
        frozen;
    END IF;
  END IF;

  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_bank_statement_update
  BEFORE UPDATE ON bank_statement
  FOR EACH ROW EXECUTE FUNCTION check_bank_statement_update();

-- -----------------------------------------------------------------------------
-- 5. The freeze.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION refuse_if_frozen(acct uuid, on_date date, what text) RETURNS void AS $$
DECLARE frozen date;
BEGIN
  frozen := bank_frozen_through(acct);
  IF frozen IS NOT NULL AND on_date <= frozen THEN
    RAISE EXCEPTION 'RECONCILED: % is on the finished reconciliation of %; undo that reconciliation first',
      what, frozen;
  END IF;
END $$ LANGUAGE plpgsql STABLE;

-- Statements: nothing may be inserted behind the freeze or deleted inside it.
-- A finished statement cannot be deleted at all without undoing it, which is
-- the same rule — its own date is not after the freeze.
CREATE OR REPLACE FUNCTION check_bank_statement_frozen() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM refuse_if_frozen(NEW.account_id, NEW.statement_date, 'a statement dated ' || NEW.statement_date);
    RETURN NEW;
  END IF;
  PERFORM refuse_if_frozen(OLD.account_id, OLD.statement_date, 'the statement of ' || OLD.statement_date);
  RETURN OLD;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_bank_statement_frozen
  BEFORE INSERT OR DELETE ON bank_statement
  FOR EACH ROW EXECUTE FUNCTION check_bank_statement_frozen();

-- Rows: a late-arriving row inside a finished period would change a difference
-- already signed as zero, so the import that carries it is refused as a whole
-- (an import is one transaction). Setting aside, putting back and deleting are
-- refused the same way.
CREATE OR REPLACE FUNCTION check_bank_row_frozen() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM refuse_if_frozen(NEW.account_id, NEW.txn_date, 'a row dated ' || NEW.txn_date);
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    PERFORM refuse_if_frozen(OLD.account_id, OLD.txn_date, 'the row of ' || OLD.txn_date);
    RETURN OLD;
  END IF;
  -- UPDATE: only the ignore decision can change (0020), and that is a change.
  IF (NEW.ignored_at IS NULL) IS DISTINCT FROM (OLD.ignored_at IS NULL) THEN
    PERFORM refuse_if_frozen(OLD.account_id, OLD.txn_date, 'the row of ' || OLD.txn_date);
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- BEFORE the audit trigger and the immutability trigger, alphabetically:
-- Postgres fires same-event triggers in name order, and a refused change
-- should not first write an audit row saying it happened.
CREATE TRIGGER trg_a_bank_row_frozen
  BEFORE INSERT OR UPDATE OR DELETE ON bank_transaction
  FOR EACH ROW EXECUTE FUNCTION check_bank_row_frozen();

-- Matches: made, moved (amendEntry re-points them) or undone.
CREATE OR REPLACE FUNCTION check_bank_match_frozen() RETURNS trigger AS $$
DECLARE b bank_transaction%ROWTYPE;
BEGIN
  SELECT * INTO b FROM bank_transaction
   WHERE id = coalesce(NEW.bank_transaction_id, OLD.bank_transaction_id);
  IF FOUND THEN
    PERFORM refuse_if_frozen(b.account_id, b.txn_date, 'the match on the row of ' || b.txn_date);
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_a_bank_match_frozen
  BEFORE INSERT OR UPDATE OR DELETE ON bank_match
  FOR EACH ROW EXECUTE FUNCTION check_bank_match_frozen();

-- -----------------------------------------------------------------------------
-- 6. The Bank seat moves from /bank/import to /bank.
--
-- The module is now two screens under one door — the feed and the reconcile —
-- and the upload is a step inside the first, not the door itself. A grant that
-- names the old path would otherwise name a seat that no longer exists (US20).
-- -----------------------------------------------------------------------------
UPDATE user_module_access SET module = '/bank' WHERE module = '/bank/import';
