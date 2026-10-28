-- 0029 — what 0028 asserted at one moment, held to afterwards
--
-- Why: docs/design/09-invoices.md, 「过账即冻结，改错的办法是作废重开」 and the
-- section under it about what 0029 closed.
--
-- 0028 wrote three invariants and enforced each of them exactly where the row it
-- was about got written. Adversarial review asked what happens AFTERWARDS — the
-- same question that produced 0026 for parties, asked again and answered the
-- same way — and found three that do not survive operations this system offers:
--
--   1. The control account can LOSE its role. `setAccountRoles` deletes every
--      role and re-inserts the ones given, and `account_role` has no DELETE
--      trigger. Strip `trade_receivables` off an account a posted invoice names
--      and the invoice's own rule is false, with nothing looking.
--   2. `posted -> void -> posted` walks round the freeze. The guard only fires
--      while the status stays 'posted', so a void hop changes the party, the
--      due date and the control account of a posted invoice; the entry does not
--      move. `void -> draft` unfreezes the LINES the same way, and re-posting
--      then leaves two live entries with the same source.
--   3. The entry can be reversed or amended out from under `entry_id`.
--      `amendEntry` deliberately carries `source_type`/`source_id` to the
--      replacement, so afterwards the invoice points at a REVERSED entry while
--      the live figure is somewhere else and `invoice_line` still holds the old
--      amounts. `check_invoice_entry` never read status.
--
-- The precedent for all three is in this repository already: `0026` re-checks a
-- party role when it changes, and `0021` refuses reversing an entry a bank row
-- still depends on. Same shape, same answer.

-- -----------------------------------------------------------------------------
-- 0. Name the constraints, so a check cannot match the wrong one.
--
-- 0028 let Postgres name two CHECKs: `invoice_check` (the due date) and
-- `invoice_check1` (posted iff it has an entry). The first is a SUBSTRING of the
-- second, and a check looking for "invoice_check" passed while tripping the
-- other one — the defect shape the PRD names in so many words. Auto-named
-- constraints are a needle waiting to collide.
-- -----------------------------------------------------------------------------
ALTER TABLE invoice DROP CONSTRAINT invoice_check;
ALTER TABLE invoice ADD CONSTRAINT invoice_due_after_issue CHECK (due_on >= issued_on);
ALTER TABLE invoice DROP CONSTRAINT invoice_check1;
ALTER TABLE invoice ADD CONSTRAINT invoice_posted_has_entry
  CHECK ((status = 'posted') = (entry_id IS NOT NULL));

-- -----------------------------------------------------------------------------
-- 1. A control account cannot lose the role that made it one.
--
-- Not "roles cannot change": retagging an account is ordinary. What is refused
-- is removing the role while an invoice that is not void still names that
-- account — the same rule `trg_role_still_covers` applies to a party's role.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_control_role_still_covers() RETURNS trigger AS $$
DECLARE
  n         bigint;
  a_code    text;
  a_name    text;
  want_direction text;
BEGIN
  IF OLD.role NOT IN ('trade_receivables', 'trade_payables') THEN RETURN NULL; END IF;

  -- Still tagged after the change? Then nothing was lost. This is what makes
  -- `setAccountRoles`'s delete-then-reinsert ordinary rather than refused.
  IF EXISTS (SELECT 1 FROM account_role ar
              WHERE ar.account_id = OLD.account_id AND ar.role = OLD.role) THEN
    RETURN NULL;
  END IF;

  want_direction := CASE WHEN OLD.role = 'trade_receivables' THEN 'sales' ELSE 'purchase' END;

  SELECT count(*) INTO n FROM invoice i
   WHERE i.control_account_id = OLD.account_id
     AND i.direction = want_direction
     AND i.status <> 'void';

  IF n > 0 THEN
    SELECT code, name INTO a_code, a_name FROM account WHERE id = OLD.account_id;
    RAISE EXCEPTION 'CONTROL_ROLE_STILL_NEEDED: % % is the control account on % % invoice%; it cannot stop being %',
      a_code, a_name, n, want_direction, CASE WHEN n = 1 THEN '' ELSE 's' END,
      replace(OLD.role, '_', ' ');
  END IF;

  RETURN NULL;
END $$ LANGUAGE plpgsql;

-- Deferred, so `setAccountRoles`'s delete-then-reinsert is judged on where it
-- ends up rather than on the gap in the middle.
CREATE CONSTRAINT TRIGGER trg_control_role_still_covers
  AFTER DELETE OR UPDATE ON account_role
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_control_role_still_covers();

-- -----------------------------------------------------------------------------
-- 2. Once it is not a draft, it is frozen — whatever it becomes next.
--
-- 0028 asked `OLD.status = 'posted' AND NEW.status = 'posted'`, which is true of
-- exactly the one transition nobody needs to make. Voiding and then posting
-- again satisfied it at every step.
--
-- The column list is longer too. `number` is what the entry's description was
-- built from, so changing it afterwards makes the ledger name a document that
-- no longer exists under that name.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION forbid_posted_invoice_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'INVOICE_NOT_DRAFT: % has been posted; void it rather than deleting it',
        COALESCE(OLD.number, 'that invoice');
    END IF;
    RETURN OLD;
  END IF;

  -- Only these three moves exist. Nothing comes back to draft, and nothing
  -- comes back from void: an invoice that was wrong is voided and another is
  -- issued, which is the same rule the ledger applies one level down.
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT ((OLD.status = 'draft'  AND NEW.status = 'posted')
           OR (OLD.status = 'draft'  AND NEW.status = 'void')
           OR (OLD.status = 'posted' AND NEW.status = 'void')) THEN
    RAISE EXCEPTION 'INVOICE_TRANSITION: % cannot go from % to %; issue another instead',
      COALESCE(NEW.number, 'that invoice'), OLD.status, NEW.status;
  END IF;

  IF OLD.status <> 'draft' THEN
    IF NEW.party_id IS DISTINCT FROM OLD.party_id
       OR NEW.issued_on IS DISTINCT FROM OLD.issued_on
       OR NEW.due_on IS DISTINCT FROM OLD.due_on
       OR NEW.control_account_id IS DISTINCT FROM OLD.control_account_id
       OR NEW.direction IS DISTINCT FROM OLD.direction
       OR NEW.ledger_id IS DISTINCT FROM OLD.ledger_id
       OR NEW.entity_id IS DISTINCT FROM OLD.entity_id
       OR NEW.number IS DISTINCT FROM OLD.number
       OR NEW.their_ref IS DISTINCT FROM OLD.their_ref
       -- `entry_id` may only be released by voiding, and only to NULL.
       OR (NEW.entry_id IS DISTINCT FROM OLD.entry_id
           AND NOT (NEW.status = 'void' AND NEW.entry_id IS NULL)) THEN
      RAISE EXCEPTION 'INVOICE_POSTED: % is % and cannot be changed; void it and issue another',
        COALESCE(NEW.number, 'that invoice'), OLD.status;
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- The lines follow the same rule: only a draft's are editable.
CREATE OR REPLACE FUNCTION forbid_posted_invoice_line_change() RETURNS trigger AS $$
DECLARE
  s text;
  n text;
BEGIN
  SELECT status, number INTO s, n FROM invoice
   WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id);

  IF s IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;

  IF s <> 'draft' THEN
    RAISE EXCEPTION 'INVOICE_POSTED: the lines of % are % and cannot be changed',
      COALESCE(n, 'that invoice'), s;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$ LANGUAGE plpgsql;

-- -----------------------------------------------------------------------------
-- 3. The entry an invoice names has to be a live one.
--
-- `check_invoice_entry` compared source and ledger and never asked whether the
-- entry was still standing. `amendEntry` carries `source_type`/`source_id` to
-- its replacement on purpose, so after a correction the invoice points at a
-- REVERSED entry while the live figure is the replacement's — and every screen
-- goes on showing the invoice as posted for its original amount.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_invoice_entry() RETURNS trigger AS $$
DECLARE
  e_source    text;
  e_source_id uuid;
  e_ledger    uuid;
  e_status    text;
  want        text;
BEGIN
  IF NEW.entry_id IS NULL THEN RETURN NULL; END IF;

  SELECT source_type, source_id, ledger_id, status
    INTO e_source, e_source_id, e_ledger, e_status
    FROM journal_entry WHERE id = NEW.entry_id;

  want := CASE WHEN NEW.direction = 'sales' THEN 'ar_invoice' ELSE 'ap_bill' END;

  IF e_source IS DISTINCT FROM want OR e_source_id IS DISTINCT FROM NEW.id THEN
    RAISE EXCEPTION 'INVOICE_ENTRY_MISMATCH: that entry is % %, not the entry this invoice produced',
      COALESCE(e_source, 'missing'), COALESCE(e_source_id::text, '');
  END IF;

  IF e_ledger IS DISTINCT FROM NEW.ledger_id THEN
    RAISE EXCEPTION 'INVOICE_ENTRY_LEDGER: that entry is in another set of books';
  END IF;

  IF e_status IS DISTINCT FROM 'posted' THEN
    RAISE EXCEPTION 'INVOICE_ENTRY_NOT_LIVE: that entry is %, so this invoice would say posted while the ledger says otherwise',
      COALESCE(e_status, 'missing');
  END IF;

  RETURN NULL;
END $$ LANGUAGE plpgsql;

-- And the other direction: reversing the entry has to reach the invoice.
--
-- Without this the rule above only holds while somebody writes to `invoice`,
-- and the operation that breaks it writes to `journal_entry`. `0021` guards the
-- identical shape for bank matches.
CREATE OR REPLACE FUNCTION check_reversed_holds_no_invoice() RETURNS trigger AS $$
DECLARE
  n      text;
  status text;
BEGIN
  IF NEW.source_type NOT IN ('ar_invoice', 'ap_bill') THEN RETURN NULL; END IF;
  IF NEW.status = 'posted' THEN RETURN NULL; END IF;

  SELECT i.number, i.status INTO n, status
    FROM invoice i WHERE i.entry_id = NEW.id;

  IF status IS NOT NULL AND status = 'posted' THEN
    RAISE EXCEPTION 'ENTRY_HOLDS_AN_INVOICE: % still names this entry as the one it produced; void the invoice first',
      COALESCE(n, 'an invoice');
  END IF;

  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_reversed_holds_no_invoice
  AFTER UPDATE ON journal_entry
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_reversed_holds_no_invoice();

-- -----------------------------------------------------------------------------
-- 4. One live entry per invoice.
--
-- With the void hop closed this is belt and braces, but it is cheap and it is
-- the shape `one_opening_balance_per_ledger` already uses: whatever route is
-- found next, two live entries claiming the same document cannot both exist.
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX one_live_entry_per_invoice
  ON journal_entry (source_type, source_id)
  WHERE source_type IN ('ar_invoice', 'ap_bill') AND status = 'posted';
