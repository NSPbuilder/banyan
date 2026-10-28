-- 0040 rebuilt forbid_posted_invoice_change from 0029's version of the
-- function — but the LIVE version was 0033's, which had added three bricks:
-- document_kind (0032's axis), created_by, and the posted_by write-once rule.
-- V29b/V29c/V77 went red within the hour. Same failure as 0039's, same
-- lesson twice in one day: a guard is rewritten from the definition the
-- database is running, not from whichever migration grep found first.
-- Append-only fix: the 0040 function with every 0033 brick back in place.

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
         OR NEW.document_kind IS DISTINCT FROM OLD.document_kind
         OR NEW.ledger_id IS DISTINCT FROM OLD.ledger_id
         OR NEW.entity_id IS DISTINCT FROM OLD.entity_id
         OR NEW.number IS DISTINCT FROM OLD.number
         OR NEW.their_ref IS DISTINCT FROM OLD.their_ref
         OR NEW.created_by IS DISTINCT FROM OLD.created_by
         OR (NEW.posted_by IS DISTINCT FROM OLD.posted_by AND OLD.posted_by IS NOT NULL)
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
    -- Identity holds even through the open door: the company, the direction,
    -- the KIND of document, and who issued it are what the document IS. An
    -- invoice that should have been a credit note is deleted and reissued.
    IF NEW.ledger_id IS DISTINCT FROM OLD.ledger_id
       OR NEW.entity_id IS DISTINCT FROM OLD.entity_id
       OR NEW.direction IS DISTINCT FROM OLD.direction
       OR NEW.document_kind IS DISTINCT FROM OLD.document_kind
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR (NEW.posted_by IS DISTINCT FROM OLD.posted_by AND OLD.posted_by IS NOT NULL) THEN
      RAISE EXCEPTION 'INVOICE_IDENTITY: % keeps its company, direction, kind and author; issue another instead',
        COALESCE(NEW.number, 'that invoice');
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
