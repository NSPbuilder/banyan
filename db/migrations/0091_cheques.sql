-- A printed cheque is numbered paper tied to one posted outflow. Keep void
-- numbers reserved; a bank's next number never goes backwards after an edit.
CREATE TABLE cheque_sequence (
  bank_account_id uuid PRIMARY KEY REFERENCES account(id),
  ledger_id uuid NOT NULL REFERENCES ledger(id),
  last_number bigint NOT NULL DEFAULT 0 CHECK (last_number >= 0)
);

CREATE TABLE cheque (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_id uuid NOT NULL REFERENCES ledger(id),
  bank_account_id uuid NOT NULL REFERENCES account(id),
  number bigint NOT NULL CHECK (number > 0),
  cheque_date date NOT NULL,
  payee text NOT NULL CHECK (length(btrim(payee)) > 0),
  amount bigint NOT NULL CHECK (amount > 0),
  memo text NOT NULL DEFAULT '',
  source_kind text NOT NULL CHECK (source_kind IN ('expense', 'payment', 'payroll', 'manual')),
  entry_id uuid REFERENCES journal_entry(id) ON DELETE SET NULL,
  pay_stub_id uuid REFERENCES pay_stub(id),
  source_entry_no text NOT NULL,
  status text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'void')),
  void_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL,
  UNIQUE (bank_account_id, number),
  CHECK ((source_kind = 'payroll') = (pay_stub_id IS NOT NULL)),
  CHECK (status = 'issued' OR length(btrim(coalesce(void_reason, ''))) > 0)
);
CREATE UNIQUE INDEX cheque_one_entry ON cheque(entry_id)
  WHERE source_kind <> 'payroll' AND entry_id IS NOT NULL;
CREATE UNIQUE INDEX cheque_one_stub ON cheque(pay_stub_id) WHERE pay_stub_id IS NOT NULL;
CREATE INDEX cheque_ledger_date ON cheque(ledger_id, cheque_date DESC);

CREATE FUNCTION cheque_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM ledger l JOIN account a ON a.entity_id = l.entity_id
     JOIN account_role ar ON ar.account_id = a.id AND ar.role = 'cash_and_cash_equivalents'
    WHERE l.id = NEW.ledger_id AND a.id = NEW.bank_account_id
  ) THEN
    RAISE EXCEPTION 'CHEQUE_BANK: account must be a bank account of this company';
  END IF;
  IF TG_TABLE_NAME = 'cheque' THEN
    IF NEW.entry_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM journal_entry e WHERE e.id = NEW.entry_id AND e.ledger_id = NEW.ledger_id
    ) THEN
      RAISE EXCEPTION 'CHEQUE_ENTRY: entry belongs to another ledger';
    END IF;
    IF NEW.pay_stub_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM pay_stub s JOIN pay_run r ON r.id = s.pay_run_id
       WHERE s.id = NEW.pay_stub_id AND r.ledger_id = NEW.ledger_id
    ) THEN
      RAISE EXCEPTION 'CHEQUE_STUB: pay stub belongs to another ledger';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cheque_scope BEFORE INSERT OR UPDATE ON cheque
  FOR EACH ROW EXECUTE FUNCTION cheque_scope_guard();
CREATE TRIGGER cheque_sequence_scope BEFORE INSERT OR UPDATE ON cheque_sequence
  FOR EACH ROW EXECUTE FUNCTION cheque_scope_guard();
