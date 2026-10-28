-- Keep an optional Party link while retaining the exact name/address printed
-- on each numbered cheque. A one-time payee has no Party record.
ALTER TABLE cheque ADD COLUMN party_id uuid REFERENCES party(id);

UPDATE cheque c SET party_id = pe.party_id
  FROM pay_stub ps JOIN payroll_employee pe ON pe.id = ps.employee_id
 WHERE c.pay_stub_id = ps.id AND c.source_kind = 'payroll';

UPDATE cheque c SET party_id = i.party_id
  FROM invoice_application ia JOIN invoice i ON i.id = ia.invoice_id AND i.direction = 'purchase'
 WHERE c.entry_id = ia.entry_id AND c.source_kind = 'payment';

UPDATE cheque c SET party_id = jl.party_id
  FROM journal_line jl
 WHERE c.entry_id = jl.entry_id AND c.source_kind IN ('expense', 'manual')
   AND jl.party_id IS NOT NULL AND jl.line_no = (
     SELECT min(jl2.line_no) FROM journal_line jl2
      WHERE jl2.entry_id = c.entry_id AND jl2.party_id IS NOT NULL);

CREATE OR REPLACE FUNCTION cheque_party_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.party_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM ledger l
     WHERE l.id = NEW.ledger_id
       AND party_may_transact(NEW.party_id, l.entity_id, NEW.cheque_date)
  ) THEN
    RAISE EXCEPTION 'CHEQUE_PARTY: party must be able to transact with this company on the cheque date';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cheque_party_scope BEFORE INSERT OR UPDATE ON cheque
  FOR EACH ROW EXECUTE FUNCTION cheque_party_scope_guard();
