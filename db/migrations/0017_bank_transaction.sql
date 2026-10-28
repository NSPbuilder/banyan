-- 0017 — bank rows, as the bank stated them
--
-- What the reader in `src/lib/bank-csv.ts` produces, landed so it can be
-- reconciled. These are NOT journal entries and never become them: a bank row
-- is a statement of what the bank says happened, and it stays that way whether
-- or not the books agree.
--
-- The whole design question here is deduplication. Importing the same file
-- twice must add nothing, and a statement that genuinely contains two identical
-- rows — two coffees, same day, same merchant, same amount — must add two.
-- Those two cases are indistinguishable by field values, which is why the usual
-- "fingerprint of account + date + amount + description" cannot do the job: it
-- collapses the second case into the first and quietly loses a transaction.
--
-- So each row carries `occurrence`: which of several identical rows this is,
-- within its own (date, amount, description). Uniqueness is over the real
-- columns plus that number.
--
-- There is deliberately NO fingerprint column. A fingerprint is the same rule
-- written a second time, in a place where the database cannot check it, and two
-- spellings of one rule is the defect this repository has spent fourteen rounds
-- of review finding. With no second spelling there is nothing to drift.

CREATE TABLE bank_transaction (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The bank account in this company's own chart. A statement is about an
  -- account, and an account belongs to an entity, so there is no ledger column:
  -- storing one would be a second answer to which books the row belongs to.
  -- That is the shape RISKS #13 records for tax registration.
  account_id    uuid NOT NULL REFERENCES account(id),

  txn_date      date   NOT NULL,
  -- Integer cents, positive when money came INTO the account. Same convention
  -- the reader uses, so nothing flips sign on the way in.
  amount        bigint NOT NULL,
  -- NOT NULL with a default, because a NULL would defeat the uniqueness below:
  -- in Postgres two NULLs are distinct, so two undescribed rows would never
  -- collide and the same file could be imported twice.
  description   text   NOT NULL DEFAULT '',

  -- 1 for the first row of its (date, amount, description), 2 for the second.
  occurrence    smallint NOT NULL DEFAULT 1 CHECK (occurrence >= 1),

  status        text NOT NULL DEFAULT 'unmatched'
                CHECK (status IN ('unmatched', 'matched', 'ignored')),

  source_file   text,
  imported_at   timestamptz NOT NULL DEFAULT now(),
  imported_by   text NOT NULL,

  UNIQUE (account_id, txn_date, amount, description, occurrence)
);

CREATE INDEX bank_transaction_account_idx ON bank_transaction (account_id, txn_date);
CREATE INDEX bank_transaction_status_idx  ON bank_transaction (account_id, status);

-- -----------------------------------------------------------------------------
-- Occurrences have no gaps.
--
-- Without this the uniqueness above is bypassable, and not in an exotic way: an
-- importer that numbered every row 1, 2, 3 down the file instead of within its
-- own group would give the same row occurrence 1 on Monday and occurrence 2 on
-- Tuesday, collide with nothing, and import it twice. The constraint would be
-- satisfied the whole time.
--
-- DEFERRED because one import inserts a whole group at once, and occurrence 2
-- is only legitimate once occurrence 1 is there. At COMMIT the whole file is in.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_occurrence_gapless() RETURNS trigger AS $$
BEGIN
  IF NEW.occurrence > 1 AND NOT EXISTS (
    SELECT 1 FROM bank_transaction b
     WHERE b.account_id  = NEW.account_id
       AND b.txn_date    = NEW.txn_date
       AND b.amount      = NEW.amount
       AND b.description = NEW.description
       AND b.occurrence  = NEW.occurrence - 1)
  THEN
    RAISE EXCEPTION 'OCCURRENCE_GAP: a bank row numbered % has no % before it (% on %)',
      NEW.occurrence, NEW.occurrence - 1, NEW.amount, NEW.txn_date;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_occurrence_gapless
  AFTER INSERT OR UPDATE ON bank_transaction
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_occurrence_gapless();

-- -----------------------------------------------------------------------------
-- The account has to be one you can post to, in a real company.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_bank_account() RETURNS trigger AS $$
DECLARE a account%ROWTYPE;
BEGIN
  SELECT * INTO a FROM account WHERE id = NEW.account_id;
  IF NOT a.is_postable THEN
    RAISE EXCEPTION 'NOT_POSTABLE: account % is a heading, not an account statements can land in', a.code;
  END IF;
  IF NOT a.is_active THEN
    RAISE EXCEPTION 'INACTIVE_ACCOUNT: account % is not active', a.code;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_bank_account
  BEFORE INSERT ON bank_transaction
  FOR EACH ROW EXECUTE FUNCTION check_bank_account();

-- -----------------------------------------------------------------------------
-- What the bank said does not change. What WE think of it does.
--
-- `status` is ours — matched, ignored, back to unmatched. The date, the amount,
-- the description and which account it came from are the bank's, and editing
-- them would turn a record of a statement into an opinion about one. It would
-- also silently move the row out from under the deduplication: change an
-- amount and the file it came from imports cleanly again.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_bank_row_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.account_id  IS DISTINCT FROM OLD.account_id
  OR NEW.txn_date    IS DISTINCT FROM OLD.txn_date
  OR NEW.amount      IS DISTINCT FROM OLD.amount
  OR NEW.description IS DISTINCT FROM OLD.description
  OR NEW.occurrence  IS DISTINCT FROM OLD.occurrence
  THEN
    RAISE EXCEPTION 'BANK_ROW_IMMUTABLE: a bank row records what the statement said; only its status can change';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_bank_row_immutable
  BEFORE UPDATE ON bank_transaction
  FOR EACH ROW EXECUTE FUNCTION check_bank_row_immutable();

-- -----------------------------------------------------------------------------
-- A row that has been matched to an entry cannot simply be deleted.
--
-- Deleting an unmatched row is a real need — imported into the wrong account,
-- and the fix is to remove it and import again. Deleting a matched one throws
-- away the only record that the entry was reconciled, and the next import of
-- the same file would bring the row back looking new.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_bank_row_delete() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'unmatched' THEN
    RAISE EXCEPTION 'BANK_ROW_%: a bank row that is % cannot be deleted; set it back to unmatched first',
      upper(OLD.status), OLD.status;
  END IF;
  RETURN OLD;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_bank_row_delete
  BEFORE DELETE ON bank_transaction
  FOR EACH ROW EXECUTE FUNCTION check_bank_row_delete();

-- -----------------------------------------------------------------------------
-- Audit. An import is a bulk event and is logged once by the application; this
-- catches everything that happens to a row afterwards, including by hand.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION log_bank_transaction() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      INSERT INTO audit_log (actor, action, table_name, record_id, before, after, context)
      VALUES (current_user, 'bank_row_status', 'bank_transaction', NEW.id::text,
              jsonb_build_object('status', OLD.status),
              jsonb_build_object('status', NEW.status),
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

CREATE TRIGGER trg_bank_transaction_audit
  AFTER UPDATE OR DELETE ON bank_transaction
  FOR EACH ROW EXECUTE FUNCTION log_bank_transaction();
