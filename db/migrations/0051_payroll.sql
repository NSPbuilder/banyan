-- 0051 — payroll: who is on it, what each pay run computed, and the paper it made
--
-- Ported from the owner's AIBookkeeper project (2026-07): a T4127 engine for
-- federal and BC, with its constants read off the official PDF and two
-- cent-exact PDOC cases as the oracle. What that project kept in memory, this
-- one keeps here.
--
-- THE SHAPE, and why:
--
-- An employee is a PARTY. The framework owns people (PRD 1.13: modules do not
-- build their own person tables), and `party_role` already has an 'employee'
-- role that transacts — so a pay run's lines can name the person the money is
-- for. This table holds only what payroll knows about them: how often they are
-- paid, what their TD1 says, what comes off before tax.
--
-- A PAY STUB is the stored fact, and the year to date is DERIVED by summing
-- stubs. That is not a preference: CPP and EI cap at annual maximums, so every
-- period's answer depends on the year before it, and a stored running total is
-- a cache that can drift from the stubs it came from. The stub carries every
-- figure a T4 box needs, per employee, because the ledger will not: the ledger
-- knows one gross and one deduction total for the whole run (owner, 2026-09-03:
-- 「可以和工资同一账户，但是考虑未来报T4，需要细分」— the breakdown lives here).
--
-- A stub also carries the EDITION it was computed under. CRA changed BC's
-- lowest rate mid-2026; a stub that cannot say which table produced it cannot
-- be re-checked.

CREATE TABLE payroll_employee (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id      uuid NOT NULL REFERENCES entity(id),
  party_id       uuid NOT NULL REFERENCES party(id),

  frequency      text NOT NULL CHECK (frequency IN
                   ('weekly','biweekly','semi_monthly','monthly','four_weekly','twenty_two','ten')),

  -- TD1 claim amounts in cents. NULL means claim code 1 — the basic amounts,
  -- which the engine works out for the edition rather than storing a copy of.
  federal_claim  bigint CHECK (federal_claim IS NULL OR federal_claim >= 0),
  bc_claim       bigint CHECK (bc_claim IS NULL OR bc_claim >= 0),

  rpp_rrsp       bigint NOT NULL DEFAULT 0 CHECK (rpp_rrsp >= 0),
  union_dues     bigint NOT NULL DEFAULT 0 CHECK (union_dues >= 0),
  additional_tax bigint NOT NULL DEFAULT 0 CHECK (additional_tax >= 0),

  -- Needed only for the T4 and the ROE. It is a social insurance number: it
  -- belongs to the same conversation as the transparency register's birth
  -- dates (05-corporate-records.md §6), and it is in the backups.
  sin            text CHECK (sin IS NULL OR sin ~ '^\d{9}$'),

  hired_on       date,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     text NOT NULL,

  -- One payroll record per person per company. Two would be two answers to
  -- "how often is she paid".
  UNIQUE (entity_id, party_id)
);

-- The person must actually be an employee of this company. The role lives in
-- the framework and says so; without this, payroll could pay a supplier and
-- the ledger would refuse the line only at posting time, halfway through.
CREATE OR REPLACE FUNCTION check_payroll_party() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM party_role pr
     WHERE pr.party_id = NEW.party_id
       AND pr.entity_id = NEW.entity_id
       AND pr.role = 'employee'
  ) THEN
    RAISE EXCEPTION 'NOT_AN_EMPLOYEE: that party holds no employee role in this company; give them one first';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_payroll_party
  BEFORE INSERT OR UPDATE ON payroll_employee
  FOR EACH ROW EXECUTE FUNCTION check_payroll_party();

CREATE TABLE pay_run (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_id    uuid NOT NULL REFERENCES ledger(id),

  -- The date the money moves. It decides the CRA edition, so it is the date
  -- the stubs were computed under, not the work period.
  pay_date     date NOT NULL,
  period_start date,
  period_end   date,

  -- Where the net pay came from, and the entry this run produced. The entry
  -- is what the books know; everything else here is why.
  bank_account_id uuid NOT NULL REFERENCES account(id),
  entry_id     uuid REFERENCES journal_entry(id),

  -- The same payday submitted twice must pay once. `journal_entry` already
  -- carries this key, but its idempotency alone would let a second RUN be
  -- written against the first run's entry — two runs, one entry, and a year
  -- to date that counts the period twice. The run is the thing being repeated,
  -- so the run is where the key belongs.
  idempotency_key text,

  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   text NOT NULL,

  CHECK (period_end IS NULL OR period_start IS NULL OR period_end >= period_start)
);
CREATE INDEX pay_run_ledger_idx ON pay_run (ledger_id, pay_date);
CREATE UNIQUE INDEX pay_run_idempotency_key ON pay_run (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE pay_stub (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pay_run_id     uuid NOT NULL REFERENCES pay_run(id) ON DELETE CASCADE,
  employee_id    uuid NOT NULL REFERENCES payroll_employee(id),

  -- Which CRA table produced these figures.
  edition        text NOT NULL,
  frequency      text NOT NULL,

  gross          bigint NOT NULL CHECK (gross >= 0),
  pensionable    bigint NOT NULL CHECK (pensionable >= 0),
  insurable      bigint NOT NULL CHECK (insurable >= 0),

  cpp            bigint NOT NULL CHECK (cpp >= 0),
  cpp2           bigint NOT NULL CHECK (cpp2 >= 0),
  ei             bigint NOT NULL CHECK (ei >= 0),
  federal_tax    bigint NOT NULL CHECK (federal_tax >= 0),
  provincial_tax bigint NOT NULL CHECK (provincial_tax >= 0),
  additional_tax bigint NOT NULL DEFAULT 0 CHECK (additional_tax >= 0),
  income_tax     bigint NOT NULL CHECK (income_tax >= 0),
  -- Nobody can be paid a negative amount. Extra tax an employee asks for on
  -- their TD1 is unbounded above, so a typo in that box is enough to compute
  -- one -- and it would balance, so postEntry would take it and the bank would
  -- be DEBITED on payday (critic).
  net_pay        bigint NOT NULL CHECK (net_pay >= 0),

  employer_cpp   bigint NOT NULL CHECK (employer_cpp >= 0),
  employer_cpp2  bigint NOT NULL CHECK (employer_cpp2 >= 0),
  employer_ei    bigint NOT NULL CHECK (employer_ei >= 0),

  -- The stub's own trial balance. A pay stub that does not add up is the one
  -- thing an employee WILL notice, and these two lines make it impossible to
  -- store one — whatever the engine did.
  CONSTRAINT pay_stub_tax_adds_up
    CHECK (income_tax = federal_tax + provincial_tax + additional_tax),
  CONSTRAINT pay_stub_net_adds_up
    CHECK (net_pay = gross - cpp - cpp2 - ei - income_tax),

  UNIQUE (pay_run_id, employee_id)
);
CREATE INDEX pay_stub_employee_idx ON pay_stub (employee_id);

-- A stub whose run has reached the books is frozen, like the journal it fed.
-- The year to date is summed from these rows, so editing one silently changes
-- every later period's CPP and EI as well.
CREATE OR REPLACE FUNCTION forbid_posted_stub_change() RETURNS trigger AS $$
DECLARE posted uuid;
BEGIN
  SELECT entry_id INTO posted FROM pay_run
   WHERE id = COALESCE(NEW.pay_run_id, OLD.pay_run_id);
  IF posted IS NOT NULL THEN
    RAISE EXCEPTION 'PAYROLL_POSTED: that pay run is in the books; reverse its entry and run it again';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_pay_stub_frozen
  BEFORE UPDATE OR DELETE ON pay_stub
  FOR EACH ROW EXECUTE FUNCTION forbid_posted_stub_change();

-- And the run itself, for the reason the trigger above CANNOT cover: the stubs
-- cascade from it, and during a cascade the parent row is already gone when the
-- child's BEFORE DELETE fires -- so the lookup finds no entry_id, reads as an
-- unposted run, and lets every stub go. One DELETE would have taken a posted
-- payday's stubs out from under the year to date and left its journal entry
-- with nothing behind it (critic; proved on temp tables of the same shape).
CREATE OR REPLACE FUNCTION forbid_posted_run_delete() RETURNS trigger AS $$
BEGIN
  IF OLD.entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'PAYROLL_POSTED: that pay run is in the books; reverse its entry, it stays on the record';
  END IF;
  RETURN OLD;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_pay_run_frozen
  BEFORE DELETE ON pay_run
  FOR EACH ROW EXECUTE FUNCTION forbid_posted_run_delete();

COMMENT ON TABLE pay_stub IS
  'One employee, one pay period, as computed. The year to date is summed from these rows and stored nowhere.';

-- Payroll is its own door (0037): a pay run's entry is not a hand-typed
-- journal, and the entry number should say so — PR, beside JE, INV, PAY.
ALTER TABLE journal_entry DROP CONSTRAINT journal_entry_source_type_check;
ALTER TABLE journal_entry ADD CONSTRAINT journal_entry_source_type_check
  CHECK (source_type IN ('manual','opening_balance','ar_invoice','ap_bill',
                         'payment','bank','period_close','adjustment',
                         'quick_expense','quick_income','payroll'));
