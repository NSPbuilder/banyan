-- Snapshot the payee address on numbered paper, while allowing a corrected
-- outflow to receive a replacement after its stale paper has been voided.
ALTER TABLE cheque ADD COLUMN payee_address text NOT NULL DEFAULT '';
DROP INDEX cheque_one_entry;
CREATE UNIQUE INDEX cheque_one_entry ON cheque(entry_id)
  WHERE source_kind <> 'payroll' AND entry_id IS NOT NULL AND status = 'issued';
DROP INDEX cheque_one_stub;
CREATE UNIQUE INDEX cheque_one_stub ON cheque(pay_stub_id)
  WHERE pay_stub_id IS NOT NULL AND status = 'issued';
