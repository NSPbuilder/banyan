-- 0023 — an opening balance is a position, not a transaction
--
-- Why: docs/design/08-opening-balances.md §3.
--
-- The cash line of an opening balance is where the account started. It is not
-- something that moved, so it cannot be what a statement row records. Left
-- alone, an opening cash balance of 12,500 would settle any deposit up to
-- 12,500 — and read as reconciled afterwards.
--
-- `candidateEntries` no longer offers it. This is the half that cannot be got
-- round by a hand-written insert.

CREATE OR REPLACE FUNCTION check_bank_match() RETURNS trigger AS $$
DECLARE
  b bank_transaction%ROWTYPE;
  entry_status text;
  entry_source text;
  on_account bigint;
BEGIN
  SELECT * INTO b FROM bank_transaction WHERE id = NEW.bank_transaction_id;

  IF b.ignored_at IS NOT NULL THEN
    RAISE EXCEPTION 'ROW_IGNORED: that row was ignored; un-ignore it before matching it';
  END IF;

  SELECT status, source_type INTO entry_status, entry_source
    FROM journal_entry WHERE id = NEW.entry_id;

  IF entry_status <> 'posted' THEN
    RAISE EXCEPTION 'ENTRY_NOT_POSTED: entry is %, and only a posted entry can settle a bank row',
      entry_status;
  END IF;

  IF entry_source = 'opening_balance' THEN
    RAISE EXCEPTION 'ENTRY_IS_OPENING: that is the opening balance — where the account started, not something that moved';
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
