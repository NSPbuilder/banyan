-- The reconciliation gains its missing half (the owner's ask: a full
-- reconciliation report with a tick-off, like QuickBooks').
--
-- Rows say what moved; only the STATEMENT's printed ending balance says what
-- the bank thinks the account HOLDS. Storing that assertion is not a cached
-- derivation — it is the bank's own fact, like the rows are — and comparing
-- it with the imported rows is the one check nothing else can make: rows
-- missing from an import, or imported twice, net against nothing and are
-- invisible to every row-by-row match. One assertion per account per date;
-- correcting a typo is DELETE and enter again, the same as a mis-imported
-- file is.
CREATE TABLE bank_statement (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES account(id),
  statement_date date NOT NULL,
  ending_balance bigint NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     text NOT NULL,
  UNIQUE (account_id, statement_date)
);
