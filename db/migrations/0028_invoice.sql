-- 0028 — invoices, in one table, posting through the one door
--
-- Why: docs/design/09-invoices.md.
--
-- A sales invoice and a purchase bill are the same document pointing in
-- opposite directions: a party, a date, some lines, and a total that lands in
-- receivables or payables. Two tables would be the customer-table/supplier-table
-- mistake again — `03` argued that out for parties and the argument does not
-- change here.
--
-- An invoice is NOT a journal entry. It is a document that produces one, the
-- way a bank row produces one: `journal_entry.source_type` is 'ar_invoice' or
-- 'ap_bill' and `source_id` is the invoice. 0001 reserved both values.
--
-- What lives here and not in the ledger: the due date, the party's own
-- reference, and the line descriptions. What lives in the ledger and not here:
-- the amounts, once posted. There is no `invoice.balance` and there will not be
-- one — see `03` on why aging is derived.

CREATE TABLE invoice (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id    uuid NOT NULL REFERENCES entity(id),
  ledger_id    uuid NOT NULL REFERENCES ledger(id),

  -- 'sales' is money owed TO this company, 'purchase' is money owed BY it.
  direction    text NOT NULL CHECK (direction IN ('sales', 'purchase')),

  party_id     uuid NOT NULL REFERENCES party(id),

  -- Ours for a sales invoice, theirs for a purchase bill. Both are 'the number
  -- this document is known by', so one column.
  number       text,
  -- What the other side calls it, when that differs. A supplier's own invoice
  -- number is how you find it when they ring up about it.
  their_ref    text,

  issued_on    date NOT NULL,
  due_on       date NOT NULL,

  -- The account the total lands in: receivables for sales, payables for
  -- purchases. Named rather than derived, because a company can have more than
  -- one — trade receivables and, say, a separate one for a related party.
  control_account_id uuid NOT NULL REFERENCES account(id),

  status       text NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft', 'posted', 'void')),
  entry_id     uuid REFERENCES journal_entry(id),

  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   text NOT NULL DEFAULT 'system',
  posted_at    timestamptz,
  posted_by    text,

  CHECK (due_on >= issued_on),
  -- Posted means posted: an invoice in that state names the entry it produced.
  CHECK ((status = 'posted') = (entry_id IS NOT NULL))
);
CREATE INDEX invoice_party_idx ON invoice (party_id, issued_on);
CREATE INDEX invoice_ledger_idx ON invoice (ledger_id, status, due_on);

-- Our own numbering is unique per company and direction. `number` is nullable
-- because a purchase bill may arrive without one, and NULLs do not collide.
CREATE UNIQUE INDEX invoice_number_unique
  ON invoice (entity_id, direction, number) WHERE number IS NOT NULL;

CREATE TABLE invoice_line (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id  uuid NOT NULL REFERENCES invoice(id) ON DELETE CASCADE,
  line_no     smallint NOT NULL,

  -- The other side of the control account: revenue for a sale, an expense or an
  -- asset for a purchase.
  account_id  uuid NOT NULL REFERENCES account(id),
  description text,

  -- Signed cents, in the same convention as the ledger: this is what the line
  -- does to `account_id`. A sales line credits revenue, so it is negative. One
  -- convention, everywhere — the opening balance screen made the same choice
  -- and for the same reason.
  amount      bigint NOT NULL CHECK (amount <> 0),

  dimensions  jsonb NOT NULL DEFAULT '{}'::jsonb,

  UNIQUE (invoice_id, line_no)
);
CREATE INDEX invoice_line_invoice_idx ON invoice_line (invoice_id);

-- -----------------------------------------------------------------------------
-- 1. A posted invoice is frozen, and so are its lines.
--
-- Same rule as a posted journal entry, for the same reason: the document and
-- the entry it produced have to keep saying the same thing. Correcting one is
-- voiding it and issuing another, which is what `amendEntry` does one level
-- down.
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

  IF OLD.status = 'posted' AND NEW.status = 'posted' THEN
    IF NEW.party_id IS DISTINCT FROM OLD.party_id
       OR NEW.issued_on IS DISTINCT FROM OLD.issued_on
       OR NEW.due_on IS DISTINCT FROM OLD.due_on
       OR NEW.control_account_id IS DISTINCT FROM OLD.control_account_id
       OR NEW.entry_id IS DISTINCT FROM OLD.entry_id
       OR NEW.direction IS DISTINCT FROM OLD.direction THEN
      RAISE EXCEPTION 'INVOICE_POSTED: % is posted and cannot be changed; void it and issue another',
        COALESCE(NEW.number, 'that invoice');
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_invoice_frozen
  BEFORE UPDATE OR DELETE ON invoice
  FOR EACH ROW EXECUTE FUNCTION forbid_posted_invoice_change();

CREATE OR REPLACE FUNCTION forbid_posted_invoice_line_change() RETURNS trigger AS $$
DECLARE
  s text;
  n text;
BEGIN
  SELECT status, number INTO s, n FROM invoice
   WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id);

  -- A cascade from deleting a draft invoice is the invoice's business, and the
  -- invoice's own trigger has already refused if it was not a draft.
  IF s IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;

  IF s <> 'draft' THEN
    RAISE EXCEPTION 'INVOICE_POSTED: the lines of % are posted and cannot be changed',
      COALESCE(n, 'that invoice');
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_invoice_line_frozen
  BEFORE INSERT OR UPDATE OR DELETE ON invoice_line
  FOR EACH ROW EXECUTE FUNCTION forbid_posted_invoice_line_change();

-- -----------------------------------------------------------------------------
-- 2. The entry an invoice produced is the entry that invoice points at.
--
-- Without this, `entry_id` is a hint. The aging reads the LEDGER, so an invoice
-- pointing at someone else's entry would put a debt on the wrong party's name
-- while both documents looked right on their own.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_invoice_entry() RETURNS trigger AS $$
DECLARE
  e_source  text;
  e_source_id uuid;
  e_ledger  uuid;
  want      text;
BEGIN
  IF NEW.entry_id IS NULL THEN RETURN NULL; END IF;

  SELECT source_type, source_id, ledger_id INTO e_source, e_source_id, e_ledger
    FROM journal_entry WHERE id = NEW.entry_id;

  want := CASE WHEN NEW.direction = 'sales' THEN 'ar_invoice' ELSE 'ap_bill' END;

  IF e_source IS DISTINCT FROM want OR e_source_id IS DISTINCT FROM NEW.id THEN
    RAISE EXCEPTION 'INVOICE_ENTRY_MISMATCH: that entry is % %, not the entry this invoice produced',
      COALESCE(e_source, 'missing'), COALESCE(e_source_id::text, '');
  END IF;

  IF e_ledger IS DISTINCT FROM NEW.ledger_id THEN
    RAISE EXCEPTION 'INVOICE_ENTRY_LEDGER: that entry is in another set of books';
  END IF;

  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_invoice_entry
  AFTER INSERT OR UPDATE ON invoice
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_invoice_entry();

-- -----------------------------------------------------------------------------
-- 3. The control account has to be the right kind of account.
--
-- A sales invoice whose total lands in an expense account balances perfectly and
-- is nonsense. The role is what says which — `trade_receivables` and
-- `trade_payables` are seeded in 0002 — so this asks the role and not the code.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_invoice_control_account() RETURNS trigger AS $$
DECLARE
  a_entity uuid;
  a_code   text;
  a_name   text;
  ok       boolean;
BEGIN
  SELECT a.entity_id, a.code, a.name INTO a_entity, a_code, a_name
    FROM account a WHERE a.id = NEW.control_account_id;

  IF a_entity IS DISTINCT FROM NEW.entity_id THEN
    RAISE EXCEPTION 'INVOICE_CONTROL_ENTITY: that account belongs to another company';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM account_role ar
     WHERE ar.account_id = NEW.control_account_id
       AND ar.role = CASE WHEN NEW.direction = 'sales'
                          THEN 'trade_receivables' ELSE 'trade_payables' END)
    INTO ok;

  IF NOT ok THEN
    RAISE EXCEPTION 'INVOICE_CONTROL_ROLE: % % is not tagged %; a % invoice has to land in one that is',
      a_code, a_name,
      CASE WHEN NEW.direction = 'sales' THEN 'trade receivables' ELSE 'trade payables' END,
      NEW.direction;
  END IF;

  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_invoice_control_account
  AFTER INSERT OR UPDATE ON invoice
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_invoice_control_account();

-- -----------------------------------------------------------------------------
-- 4. Issuing and voiding are worth a record.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION log_invoice_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO audit_log (actor, action, table_name, record_id, after, context)
    VALUES (NEW.created_by, 'create_invoice', 'invoice', NEW.id::text,
            jsonb_build_object('direction', NEW.direction, 'number', NEW.number,
                               'issued_on', NEW.issued_on, 'due_on', NEW.due_on),
            jsonb_build_object('party_id', NEW.party_id, 'ledger_id', NEW.ledger_id));
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO audit_log (actor, action, table_name, record_id, before, after)
    VALUES (COALESCE(NEW.posted_by, current_user),
            CASE WHEN NEW.status = 'posted' THEN 'post_invoice' ELSE 'void_invoice' END,
            'invoice', NEW.id::text,
            jsonb_build_object('status', OLD.status),
            jsonb_build_object('status', NEW.status, 'entry_id', NEW.entry_id));
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_invoice_audit
  AFTER INSERT OR UPDATE ON invoice
  FOR EACH ROW EXECUTE FUNCTION log_invoice_change();
