-- 0034 — which money settles which invoice
--
-- Why: docs/design/11-payments.md.
--
-- A payment has NO table of its own: a receipt is a journal entry (source_type
-- 'payment', reserved since 0001) whose control line names the party, and every
-- column a payment table would carry is a column journal_entry already has.
-- What is new is the LINK: entry E settles amount A of invoice I.
--
-- The link hangs off the ENTRY, not off a payment document, so a credit note's
-- entry applies to an invoice through the same table with no special case —
-- a sales credit note credits receivables exactly the way a receipt does.
-- `bank_match` (0020) is the precedent, down to the shape: many-to-many, an
-- amount per link, UNIQUE so one pair says one thing, partial settlement an
-- ordinary state rather than a workaround.
--
-- There is no invoice.balance and no paid flag. The balance is
-- |control movement| − Σ applications, derived every time it is read.

CREATE TABLE invoice_application (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id  uuid NOT NULL REFERENCES invoice(id),
  entry_id    uuid NOT NULL REFERENCES journal_entry(id),
  -- Positive cents of debt settled. The DIRECTION lives in the ledger lines the
  -- triggers below inspect; storing a sign here as well would be the same fact
  -- in two places, free to disagree.
  amount      bigint NOT NULL CHECK (amount > 0),
  applied_at  timestamptz NOT NULL DEFAULT now(),
  applied_by  text NOT NULL,
  UNIQUE (invoice_id, entry_id)
);

CREATE INDEX invoice_application_invoice_idx ON invoice_application (invoice_id);
CREATE INDEX invoice_application_entry_idx   ON invoice_application (entry_id);

-- -----------------------------------------------------------------------------
-- 1. An application row is settle-or-delete, not editable.
--
-- Unapplying is DELETE (the ledger never moved, so there is nothing to
-- reverse); a wrong amount is unapply-and-reapply. The one column that may
-- change is entry_id, because amendEntry carries applications from a reversed
-- original to its replacement the same way it carries bank matches — and the
-- deferred validity trigger below re-checks the replacement before commit.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION forbid_application_edit() RETURNS trigger AS $$
BEGIN
  IF NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
     OR NEW.amount  IS DISTINCT FROM OLD.amount THEN
    RAISE EXCEPTION 'APPLICATION_IMMUTABLE: unapply it and apply again rather than editing it';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_application_edit
  BEFORE UPDATE ON invoice_application
  FOR EACH ROW EXECUTE FUNCTION forbid_application_edit();

-- -----------------------------------------------------------------------------
-- 2. The application has to be TRUE, checked at commit.
--
-- Deferred, because a payment posts its entry and its application in one
-- transaction, and because amendEntry moves applications between two entries
-- mid-transaction.
--
-- What has to hold, and what breaks if it silently did not:
--   * both documents alive — a draft invoice is not yet a debt, a void one is
--     no longer one, a draft entry is not yet money;
--   * one ledger — money in one company's books settling a debt in another's
--     is the intercompany machinery this project explicitly does not have;
--   * the entry really moves this invoice's control account, for this party,
--     the OPPOSITE way — an entry that never touched receivables "paying" a
--     sales invoice reads fine from both ends and is nonsense in the middle;
--   * neither side over-applied — a 1,000 receipt settling 1,200 of debt has
--     invented 200 from nowhere, and the books would still balance.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_application_valid() RETURNS trigger AS $$
DECLARE
  inv        record;
  ent_status text;
  ent_ledger uuid;
  inv_mov    bigint;   -- what the invoice's entry did to the control account
  settle_cap bigint;   -- what the settling entry can pay for this account+party
  inv_applied bigint;
  ent_applied bigint;
BEGIN
  SELECT i.id, i.status, i.ledger_id, i.party_id, i.control_account_id,
         i.entry_id, i.number
    INTO inv
    FROM invoice i WHERE i.id = NEW.invoice_id;

  IF inv.status <> 'posted' THEN
    RAISE EXCEPTION 'APPLICATION_INVOICE_NOT_POSTED: % is %, and only a posted invoice is a debt',
      COALESCE(inv.number, 'that invoice'), inv.status;
  END IF;

  SELECT je.status, je.ledger_id INTO ent_status, ent_ledger
    FROM journal_entry je WHERE je.id = NEW.entry_id;

  IF ent_status <> 'posted' THEN
    RAISE EXCEPTION 'APPLICATION_ENTRY_NOT_POSTED: that entry is %, not posted', ent_status;
  END IF;

  IF ent_ledger IS DISTINCT FROM inv.ledger_id THEN
    RAISE EXCEPTION 'APPLICATION_LEDGER: that entry is in another set of books';
  END IF;

  -- The debt, read from the ledger rather than from the document.
  SELECT COALESCE(SUM(jl.amount), 0) INTO inv_mov
    FROM journal_line jl
   WHERE jl.entry_id = inv.entry_id
     AND jl.account_id = inv.control_account_id
     AND jl.party_id = inv.party_id;

  IF inv_mov = 0 THEN
    RAISE EXCEPTION 'APPLICATION_NO_DEBT: the entry behind % holds nothing on its control account',
      COALESCE(inv.number, 'that invoice');
  END IF;

  -- What the settling entry moved on the SAME account for the SAME party in
  -- the settling direction (the opposite sign of the debt).
  SELECT COALESCE(SUM(jl.amount), 0) INTO settle_cap
    FROM journal_line jl
   WHERE jl.entry_id = NEW.entry_id
     AND jl.account_id = inv.control_account_id
     AND jl.party_id = inv.party_id
     AND sign(jl.amount) = -sign(inv_mov);

  IF settle_cap = 0 THEN
    RAISE EXCEPTION 'APPLICATION_WRONG_WAY: that entry does not move %''s control account toward settling it',
      COALESCE(inv.number, 'that invoice');
  END IF;

  -- Neither side may promise more than it holds.
  SELECT COALESCE(SUM(a.amount), 0) INTO inv_applied
    FROM invoice_application a WHERE a.invoice_id = NEW.invoice_id;

  IF inv_applied > abs(inv_mov) THEN
    RAISE EXCEPTION 'APPLICATION_OVER_INVOICE: % settled of a % debt on %',
      inv_applied, abs(inv_mov), COALESCE(inv.number, 'that invoice');
  END IF;

  SELECT COALESCE(SUM(a.amount), 0) INTO ent_applied
    FROM invoice_application a
    JOIN invoice i2 ON i2.id = a.invoice_id
   WHERE a.entry_id = NEW.entry_id
     AND i2.control_account_id = inv.control_account_id
     AND i2.party_id = inv.party_id;

  IF ent_applied > abs(settle_cap) THEN
    RAISE EXCEPTION 'APPLICATION_OVER_ENTRY: that entry holds % toward this party and % is already applied',
      abs(settle_cap), ent_applied;
  END IF;

  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_application_valid
  AFTER INSERT OR UPDATE ON invoice_application
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_application_valid();

-- -----------------------------------------------------------------------------
-- 3. A reversed entry cannot still be paying invoices.
--
-- 0021's rule for bank matches, moved over with its reasoning intact: reversing
-- an entry unwinds the money, and a link left behind reports a debt settled by
-- money that has been taken back. amendEntry carries the applications to the
-- replacement between its two statements, which is why this is deferred.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_reversed_holds_no_application() RETURNS trigger AS $$
DECLARE stuck int;
BEGIN
  IF NEW.status <> 'reversed' THEN RETURN NULL; END IF;

  SELECT count(*) INTO stuck FROM invoice_application a WHERE a.entry_id = NEW.id;
  IF stuck > 0 THEN
    RAISE EXCEPTION 'REVERSED_STILL_APPLIED: entry % settles % invoice(s); unapply before reversing it',
      coalesce(NEW.entry_no, NEW.id::text), stuck;
  END IF;

  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_reversed_holds_no_application
  AFTER UPDATE ON journal_entry
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_reversed_holds_no_application();

-- -----------------------------------------------------------------------------
-- 4. An invoice with applications cannot be voided.
--
-- Voiding reverses the invoice's entry; the payment would be left applied to a
-- debt that no longer exists. Unapply first — both steps leave their own audit
-- rows, which is the point of making it two steps.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_void_holds_no_application() RETURNS trigger AS $$
DECLARE stuck int;
BEGIN
  IF NEW.status <> 'void' OR OLD.status = 'void' THEN RETURN NEW; END IF;

  SELECT count(*) INTO stuck FROM invoice_application a WHERE a.invoice_id = NEW.id;
  IF stuck > 0 THEN
    RAISE EXCEPTION 'APPLIED_CANNOT_VOID: % has % application(s) against it; unapply them before voiding it',
      COALESCE(NEW.number, 'that invoice'), stuck;
  END IF;

  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_void_holds_no_application
  BEFORE UPDATE ON invoice
  FOR EACH ROW EXECUTE FUNCTION check_void_holds_no_application();

-- -----------------------------------------------------------------------------
-- 5. Applying and unapplying are worth a record.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION log_application_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO audit_log (actor, action, table_name, record_id, after)
    VALUES (NEW.applied_by, 'apply_to_invoice', 'invoice_application', NEW.id::text,
            jsonb_build_object('invoice_id', NEW.invoice_id, 'entry_id', NEW.entry_id,
                               'amount', NEW.amount));
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    INSERT INTO audit_log (actor, action, table_name, record_id, before)
    VALUES (current_user, 'unapply_from_invoice', 'invoice_application', OLD.id::text,
            jsonb_build_object('invoice_id', OLD.invoice_id, 'entry_id', OLD.entry_id,
                               'amount', OLD.amount));
    RETURN OLD;
  END IF;

  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_application_audit
  AFTER INSERT OR DELETE ON invoice_application
  FOR EACH ROW EXECUTE FUNCTION log_application_change();
