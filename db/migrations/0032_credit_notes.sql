-- 0032 — a credit note is the same document pointing the other way
--
-- Why: docs/design/09-invoices.md, 「贷项通知单：同一张表的第四个格子」.
--
-- `createInvoice` has been refusing these by name since 0028: lines that move
-- the control account the wrong way for the direction are "a credit note, and
-- those are not built yet". This builds them, and does it by adding a second
-- axis rather than a second table — the same argument `03` makes about parties
-- and `09` section 1 makes about sales versus purchase.
--
-- Two axes, four combinations, and the sign falls out of the pair:
--
--                       invoice            credit_note
--   sales      debit receivables      credit receivables
--   purchase   credit payables         debit payables
--
-- A sales credit note reduces what a customer owes; a purchase credit note
-- reduces what this company owes a supplier. Both keep the party role of their
-- direction — a credit note goes to the customer it credits — so 0030 needs no
-- change, and both keep the control account of their direction, so 0028's rule
-- needs none either. Only the sign moves.
--
-- Numbering gains the kind: INV-001 and CN-001 are different documents and a
-- company that numbers them in one sequence is free to, but two documents of
-- different kinds sharing a number is not a collision worth refusing.

ALTER TABLE invoice ADD COLUMN document_kind text NOT NULL DEFAULT 'invoice'
  CHECK (document_kind IN ('invoice', 'credit_note'));

DROP INDEX invoice_number_unique;
CREATE UNIQUE INDEX invoice_number_unique
  ON invoice (entity_id, direction, document_kind, number) WHERE number IS NOT NULL;

-- The kind is part of what a posted document IS, so it freezes with the rest.
-- `forbid_posted_invoice_change` lists the frozen columns one by one rather than
-- comparing whole rows, which means a new column is unfrozen until somebody
-- remembers. This is that remembering, and the reason the list is a list: a row
-- comparison would also freeze `posted_at`, which the posting itself writes.
CREATE OR REPLACE FUNCTION forbid_posted_invoice_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'INVOICE_NOT_DRAFT: % has been posted; void it rather than deleting it',
        COALESCE(OLD.number, 'that invoice');
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
       OR (NEW.entry_id IS DISTINCT FROM OLD.entry_id
           AND NOT (NEW.status = 'void' AND NEW.entry_id IS NULL)) THEN
      RAISE EXCEPTION 'INVOICE_POSTED: % is % and cannot be changed; void it and issue another',
        COALESCE(NEW.number, 'that invoice'), OLD.status;
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
