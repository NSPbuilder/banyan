-- 0020 — reconciling a bank row against the books
--
-- Why matches are rows and not a column: docs/design/07-bank-matching.md.
--
-- WHAT CHANGES
--   * bank_match: which entries account for which parts of which bank rows
--   * bank_transaction gains an explicit ignore decision (with a reason)
--   * bank_transaction.status is DROPPED — see the note below
--   * bank_row_state: the one place a row's state is worked out

-- -----------------------------------------------------------------------------
-- 1. The link.
--
-- One bank row can need several entries (a deposit covering three invoices) and
-- one entry can be settled by several bank rows (an invoice paid in two goes).
-- Each link carries the part of the row that entry accounts for, so a partial
-- match is an ordinary state rather than a thing to work around.
-- -----------------------------------------------------------------------------
CREATE TABLE bank_match (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_transaction_id uuid   NOT NULL REFERENCES bank_transaction(id),
  entry_id            uuid   NOT NULL REFERENCES journal_entry(id),
  -- Signed cents, same sign as the bank row: positive is money into the account.
  amount              bigint NOT NULL CHECK (amount <> 0),
  matched_at          timestamptz NOT NULL DEFAULT now(),
  matched_by          text   NOT NULL,
  -- One link per pair. Two amounts for the same pair would be one fact twice.
  UNIQUE (bank_transaction_id, entry_id)
);

CREATE INDEX bank_match_row_idx   ON bank_match (bank_transaction_id);
CREATE INDEX bank_match_entry_idx ON bank_match (entry_id);

-- -----------------------------------------------------------------------------
-- 2. Ignoring is a decision, so it is stored, and it needs a reason.
--
-- Same shape as closing a period over a blocker: the system does not need the
-- reason, the person reading the books in a year does.
-- -----------------------------------------------------------------------------
ALTER TABLE bank_transaction
  ADD COLUMN ignored_at     timestamptz,
  ADD COLUMN ignored_by     text,
  ADD COLUMN ignored_reason text;

ALTER TABLE bank_transaction ADD CONSTRAINT bank_transaction_ignored CHECK (
  (ignored_at IS NULL AND ignored_by IS NULL AND ignored_reason IS NULL)
  OR (ignored_at IS NOT NULL AND ignored_by IS NOT NULL
      AND coalesce(length(btrim(ignored_reason)), 0) >= 3));

UPDATE bank_transaction
   SET ignored_at = now(), ignored_by = 'migration 0020', ignored_reason = 'carried over from status'
 WHERE status = 'ignored';

-- -----------------------------------------------------------------------------
-- 3. Whether a row is matched stops being written down.
--
-- It is a fact about the row's links, and `bank_match` holds those. Keeping a
-- column as well would be the same fact in two places, free to disagree — which
-- is this repository's most common defect, found fourteen times before this
-- table existed.
--
-- `period_balance` is a cache and is defended as one, but it is a cache for a
-- reason: summing every journal line is expensive. Summing a bank row's handful
-- of matches is not. A cache with no cost to justify it is just a second answer.
-- -----------------------------------------------------------------------------
DROP INDEX bank_transaction_status_idx;

CREATE OR REPLACE FUNCTION log_bank_transaction() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.ignored_at IS NULL) IS DISTINCT FROM (OLD.ignored_at IS NULL) THEN
      INSERT INTO audit_log (actor, action, table_name, record_id, before, after, context)
      VALUES (coalesce(NEW.ignored_by, current_user),
              CASE WHEN NEW.ignored_at IS NULL THEN 'bank_row_unignored' ELSE 'bank_row_ignored' END,
              'bank_transaction', NEW.id::text,
              jsonb_build_object('ignored_at', OLD.ignored_at, 'reason', OLD.ignored_reason),
              jsonb_build_object('ignored_at', NEW.ignored_at, 'reason', NEW.ignored_reason),
              jsonb_build_object('account_id', NEW.account_id, 'txn_date', NEW.txn_date));
    END IF;
    RETURN NEW;
  END IF;

  INSERT INTO audit_log (actor, action, table_name, record_id, before, context)
  VALUES (current_user, 'bank_row_delete', 'bank_transaction', OLD.id::text,
          jsonb_build_object('txn_date', OLD.txn_date, 'amount', OLD.amount,
                             'description', OLD.description, 'occurrence', OLD.occurrence),
          jsonb_build_object('account_id', OLD.account_id));
  RETURN OLD;
END $$ LANGUAGE plpgsql;

-- The delete guard stops reading `status` and starts reading what is true.
CREATE OR REPLACE FUNCTION check_bank_row_delete() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM bank_match m WHERE m.bank_transaction_id = OLD.id) THEN
    RAISE EXCEPTION 'BANK_ROW_MATCHED: that row is reconciled to an entry; undo the match first';
  END IF;
  IF OLD.ignored_at IS NOT NULL THEN
    RAISE EXCEPTION 'BANK_ROW_IGNORED: that row was ignored on purpose; un-ignore it first';
  END IF;
  RETURN OLD;
END $$ LANGUAGE plpgsql;

ALTER TABLE bank_transaction DROP COLUMN status;

-- The immutability guard named `status` as the one thing that may change; now it
-- is the ignore decision. Everything the bank said is still frozen.
--
-- And ignoring is only available while the row means nothing to the books. A row
-- with matches that is then set aside would vanish from the reconciliation while
-- its matches went on claiming parts of entries — the state view answers
-- "ignored" first, so the matches would still be there and no longer visible.
CREATE OR REPLACE FUNCTION check_bank_row_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.ignored_at IS NOT NULL AND OLD.ignored_at IS NULL
     AND EXISTS (SELECT 1 FROM bank_match m WHERE m.bank_transaction_id = NEW.id) THEN
    RAISE EXCEPTION 'ROW_IS_MATCHED: that row is reconciled to an entry; undo the match before setting it aside';
  END IF;

  IF NEW.account_id  IS DISTINCT FROM OLD.account_id
  OR NEW.txn_date    IS DISTINCT FROM OLD.txn_date
  OR NEW.amount      IS DISTINCT FROM OLD.amount
  OR NEW.description IS DISTINCT FROM OLD.description
  OR NEW.occurrence  IS DISTINCT FROM OLD.occurrence
  THEN
    RAISE EXCEPTION 'BANK_ROW_IMMUTABLE: a bank row records what the statement said; only whether it is ignored can change';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- -----------------------------------------------------------------------------
-- 4. A match has to mean something.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_bank_match() RETURNS trigger AS $$
DECLARE
  b bank_transaction%ROWTYPE;
  entry_status text;
  on_account bigint;
BEGIN
  SELECT * INTO b FROM bank_transaction WHERE id = NEW.bank_transaction_id;

  IF b.ignored_at IS NOT NULL THEN
    RAISE EXCEPTION 'ROW_IGNORED: that row was ignored; un-ignore it before matching it';
  END IF;

  SELECT status INTO entry_status FROM journal_entry WHERE id = NEW.entry_id;
  IF entry_status <> 'posted' THEN
    RAISE EXCEPTION 'ENTRY_NOT_POSTED: entry is %, and only a posted entry can settle a bank row',
      entry_status;
  END IF;

  -- The entry must actually have done something on this bank account, or the
  -- match is a sentence about two unrelated things.
  SELECT sum(jl.amount) INTO on_account
    FROM journal_line jl
   WHERE jl.entry_id = NEW.entry_id AND jl.account_id = b.account_id;

  IF on_account IS NULL THEN
    RAISE EXCEPTION 'ENTRY_NOT_ON_ACCOUNT: that entry has no line on the account this statement is for';
  END IF;

  IF sign(NEW.amount) <> sign(b.amount) THEN
    RAISE EXCEPTION 'MATCH_SIGN: the bank row is % and the match is %; money cannot go both ways',
      CASE WHEN b.amount > 0 THEN 'money in' ELSE 'money out' END,
      CASE WHEN NEW.amount > 0 THEN 'money in' ELSE 'money out' END;
  END IF;

  IF sign(NEW.amount) <> sign(on_account) THEN
    RAISE EXCEPTION 'ENTRY_SIGN: that entry moved the account the other way';
  END IF;

  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_bank_match
  BEFORE INSERT OR UPDATE ON bank_match
  FOR EACH ROW EXECUTE FUNCTION check_bank_match();

-- -----------------------------------------------------------------------------
-- 5. The arithmetic, checked at COMMIT because one action writes several links.
--
-- Two sums, both bounded, and they are what make "partly matched" a state you
-- can be in rather than a mistake:
--
--   a row's matches may not exceed the row
--   an entry's matches may not exceed what that entry did on that account
--
-- Without the second, one $500 payment could settle five different $500 deposits
-- and every one of them would look reconciled.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_match_totals() RETURNS trigger AS $$
DECLARE
  row_id uuid;
  b bank_transaction%ROWTYPE;
  matched bigint;
  entry_total bigint;
  on_account bigint;
BEGIN
  row_id := coalesce(NEW.bank_transaction_id, OLD.bank_transaction_id);
  SELECT * INTO b FROM bank_transaction WHERE id = row_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT coalesce(sum(amount), 0) INTO matched FROM bank_match WHERE bank_transaction_id = row_id;
  IF abs(matched) > abs(b.amount) THEN
    RAISE EXCEPTION 'OVER_MATCHED: that row is % and % is already accounted for',
      b.amount, matched;
  END IF;

  IF NEW.entry_id IS NOT NULL THEN
    SELECT coalesce(sum(m.amount), 0) INTO entry_total
      FROM bank_match m JOIN bank_transaction bb ON bb.id = m.bank_transaction_id
     WHERE m.entry_id = NEW.entry_id AND bb.account_id = b.account_id;

    SELECT coalesce(sum(jl.amount), 0) INTO on_account
      FROM journal_line jl
     WHERE jl.entry_id = NEW.entry_id AND jl.account_id = b.account_id;

    IF abs(entry_total) > abs(on_account) THEN
      RAISE EXCEPTION 'ENTRY_OVER_MATCHED: that entry moved % on this account and % is already claimed against it',
        on_account, entry_total;
    END IF;
  END IF;

  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_match_totals
  AFTER INSERT OR UPDATE OR DELETE ON bank_match
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_match_totals();

-- -----------------------------------------------------------------------------
-- 6. The one place a row's state is worked out.
-- -----------------------------------------------------------------------------
CREATE VIEW bank_row_state AS
SELECT b.id, b.account_id, b.txn_date, b.amount, b.description, b.occurrence,
       b.source_file, b.imported_at, b.imported_by,
       b.ignored_at, b.ignored_by, b.ignored_reason,
       coalesce(m.matched, 0)::bigint AS matched_amount,
       (b.amount - coalesce(m.matched, 0))::bigint AS unmatched_amount,
       CASE
         WHEN b.ignored_at IS NOT NULL       THEN 'ignored'
         WHEN coalesce(m.matched, 0) = 0     THEN 'unmatched'
         WHEN m.matched = b.amount           THEN 'matched'
         ELSE 'part'
       END AS state
  FROM bank_transaction b
  LEFT JOIN (SELECT bank_transaction_id, sum(amount) AS matched
               FROM bank_match GROUP BY bank_transaction_id) m
    ON m.bank_transaction_id = b.id;
