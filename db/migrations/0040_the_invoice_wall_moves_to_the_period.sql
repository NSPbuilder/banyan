-- The invoice wall moves to the period, like the entry wall did in 0038.
--
-- Open books (docs/design/14-open-books.md): a posted invoice may be edited
-- or deleted through the application while the period its entry sits in is
-- OPEN. Raw SQL still bounces (no erp.open_edit flag), a closed period still
-- refuses everything, and the entry linkage stays coherent because the
-- application regenerates the entry in the same transaction as the document
-- change. The draft and void states remain legal in the schema so history
-- reads; the application stops producing them.

CREATE OR REPLACE FUNCTION invoice_period_is_open(p_entry_id uuid) RETURNS boolean AS $$
  SELECT CASE WHEN p_entry_id IS NULL THEN true
              ELSE entry_period_is_open(p_entry_id) END
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION forbid_posted_invoice_change() RETURNS trigger AS $$
DECLARE v_open_edit boolean;
BEGIN
  v_open_edit := COALESCE(current_setting('erp.open_edit', true), '') = 'on';

  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'draft' THEN RETURN OLD; END IF;
    IF NOT v_open_edit THEN
      RAISE EXCEPTION 'INVOICE_RAW_SQL: % can only be deleted through the application — deleteInvoice rebalances, audits, and takes the entry with it',
        COALESCE(OLD.number, 'that invoice');
    END IF;
    IF NOT invoice_period_is_open(OLD.entry_id) THEN
      RAISE EXCEPTION 'PERIOD_CLOSED: % sits in a closed period', COALESCE(OLD.number, 'that invoice');
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT ((OLD.status = 'draft'  AND NEW.status = 'posted')
           OR (OLD.status = 'draft'  AND NEW.status = 'void')
           OR (OLD.status = 'posted' AND NEW.status = 'void')) THEN
    RAISE EXCEPTION 'INVOICE_TRANSITION: % cannot go from % to %; issue another instead',
      COALESCE(NEW.number, 'that invoice'), OLD.status, NEW.status;
  END IF;

  IF OLD.status <> 'draft' THEN
    IF NOT v_open_edit THEN
      IF NEW.party_id IS DISTINCT FROM OLD.party_id
         OR NEW.issued_on IS DISTINCT FROM OLD.issued_on
         OR NEW.due_on IS DISTINCT FROM OLD.due_on
         OR NEW.control_account_id IS DISTINCT FROM OLD.control_account_id
         OR NEW.direction IS DISTINCT FROM OLD.direction
         OR NEW.ledger_id IS DISTINCT FROM OLD.ledger_id
         OR NEW.entity_id IS DISTINCT FROM OLD.entity_id
         OR NEW.number IS DISTINCT FROM OLD.number
         OR NEW.their_ref IS DISTINCT FROM OLD.their_ref
         OR (NEW.entry_id IS DISTINCT FROM OLD.entry_id
             AND NOT (NEW.status = 'void' AND NEW.entry_id IS NULL)) THEN
        RAISE EXCEPTION 'INVOICE_RAW_SQL: % can only be changed through the application — editInvoice regenerates its entry in the same breath',
          COALESCE(NEW.number, 'that invoice');
      END IF;
      RETURN NEW;
    END IF;

    IF NOT invoice_period_is_open(OLD.entry_id) THEN
      RAISE EXCEPTION 'PERIOD_CLOSED: % sits in a closed period', COALESCE(NEW.number, 'that invoice');
    END IF;
    -- Identity holds even through the open door.
    IF NEW.ledger_id IS DISTINCT FROM OLD.ledger_id
       OR NEW.entity_id IS DISTINCT FROM OLD.entity_id
       OR NEW.direction IS DISTINCT FROM OLD.direction THEN
      RAISE EXCEPTION 'INVOICE_IDENTITY: % keeps its company and its direction; issue another instead',
        COALESCE(NEW.number, 'that invoice');
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION forbid_posted_invoice_line_change() RETURNS trigger AS $$
DECLARE
  s text;
  n text;
  e uuid;
  v_open_edit boolean;
BEGIN
  SELECT status, number, entry_id INTO s, n, e FROM invoice
   WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id);

  IF s IS NULL OR s = 'draft' THEN RETURN COALESCE(NEW, OLD); END IF;

  v_open_edit := COALESCE(current_setting('erp.open_edit', true), '') = 'on';
  IF NOT v_open_edit THEN
    RAISE EXCEPTION 'INVOICE_RAW_SQL: the lines of % can only be changed through the application',
      COALESCE(n, 'that invoice');
  END IF;
  IF NOT invoice_period_is_open(e) THEN
    RAISE EXCEPTION 'PERIOD_CLOSED: % sits in a closed period', COALESCE(n, 'that invoice');
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$ LANGUAGE plpgsql;
