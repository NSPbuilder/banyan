-- =============================================================================
-- P0 — LEDGER KERNEL
-- Personal multi-entity accounting system (Canada). PostgreSQL 14+.
--
-- Design rules enforced here (not just documented):
--   1. Posted journal entries are immutable. Corrections happen by reversal.
--   2. Every posted entry balances. Enforced by a DEFERRED constraint trigger,
--      so no application bug can write an unbalanced entry.
--   3. Nothing posts into a closed period.
--   4. Money is stored as integer cents (bigint). Never floats.
--   5. Reports reference ACCOUNT ROLES, never account codes.
--   6. Dimensions are data, not columns.
--
-- Naming: all identifiers are English. Comments explain intent.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()

-- -----------------------------------------------------------------------------
-- 1. ENTITY — one legal company. You have several; they are fully independent.
-- -----------------------------------------------------------------------------
CREATE TABLE entity (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                    text        NOT NULL UNIQUE,          -- 'ACME'
  name                    text        NOT NULL,                 -- display name
  legal_name              text,
  country                 char(2)     NOT NULL DEFAULT 'CA',
  province                text,                                 -- 'ON','QC','BC' — drives PST/QST later
  business_number         text,                                 -- CRA BN / GST-HST number
  functional_currency     char(3)     NOT NULL DEFAULT 'CAD',
  fiscal_year_end_month   smallint    NOT NULL DEFAULT 12 CHECK (fiscal_year_end_month BETWEEN 1 AND 12),
  fiscal_year_end_day     smallint    NOT NULL DEFAULT 31 CHECK (fiscal_year_end_day   BETWEEN 1 AND 31),
  is_active               boolean     NOT NULL DEFAULT true,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- 1b. ACCOUNTING STANDARD — a reference table, not a CHECK constraint.
--     Adding a basis later is an INSERT, never a migration.
-- -----------------------------------------------------------------------------
CREATE TABLE accounting_standard (
  code        text PRIMARY KEY,          -- 'IFRS'
  name        text NOT NULL,             -- 'IFRS (as adopted in Canada, Part I)'
  is_active   boolean NOT NULL DEFAULT true
);
INSERT INTO accounting_standard (code, name) VALUES
  ('IFRS', 'IFRS — CPA Canada Handbook Part I'),
  ('ASPE', 'Accounting Standards for Private Enterprises — Part II');

-- -----------------------------------------------------------------------------
-- 2. LEDGER — a set of books for an entity under one measurement basis.
--    You will have exactly one per entity for years. The column exists so that
--    adding a tax-basis book later is a config change, not a data migration.
-- -----------------------------------------------------------------------------
CREATE TABLE ledger (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id            uuid NOT NULL REFERENCES entity(id),
  code                 text NOT NULL,                            -- 'PRIMARY'
  name                 text NOT NULL,
  purpose              text NOT NULL DEFAULT 'statutory'
                         CHECK (purpose IN ('statutory','tax','management')),
  accounting_standard  text NOT NULL DEFAULT 'IFRS'
                         REFERENCES accounting_standard(code),
  currency             char(3) NOT NULL DEFAULT 'CAD',
  is_primary           boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_id, code)
);
CREATE UNIQUE INDEX ledger_one_primary_per_entity
  ON ledger (entity_id) WHERE is_primary;

-- -----------------------------------------------------------------------------
-- 3. ACCOUNT — chart of accounts, per entity, hierarchical.
--    Ledgers of the same entity share its chart.
-- -----------------------------------------------------------------------------
CREATE TYPE account_type    AS ENUM ('asset','liability','equity','revenue','expense');
CREATE TYPE normal_balance  AS ENUM ('debit','credit');

CREATE TABLE account (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id      uuid NOT NULL REFERENCES entity(id),
  code           text NOT NULL,                                  -- '1100'
  name           text NOT NULL,                                  -- 'Cash — Operating'
  parent_id      uuid REFERENCES account(id),
  account_type   account_type   NOT NULL,
  normal_balance normal_balance NOT NULL,   -- stored, not derived: contra accounts flip it
  -- Header/rollup accounts cannot be posted to directly.
  is_postable    boolean NOT NULL DEFAULT true,
  -- Dimensions that MUST be supplied when posting to this account, e.g. ARRAY['DEPARTMENT'].
  required_dimensions text[] NOT NULL DEFAULT '{}',
  description    text,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_id, code)
);
CREATE INDEX account_entity_idx ON account (entity_id, code);

-- -----------------------------------------------------------------------------
-- 4. ROLES — the pluggable-standard layer.
--    Statements reference roles; they never reference account codes.
--    Swapping ASPE -> IFRS means swapping statement templates, not the chart.
-- -----------------------------------------------------------------------------
CREATE TABLE role_definition (
  code        text PRIMARY KEY,          -- 'trade_receivables'
  label       text NOT NULL,             -- 'Trade receivables'
  category    account_type,             -- NULL only for cash_flow-family roles

  -- Which axis this role classifies on. An account normally carries ONE
  -- 'classification' role, plus — for expense accounts — one 'nature' role
  -- and one 'function' role, so both IAS 1 P&L formats work off one chart.
  family      text NOT NULL DEFAULT 'classification'
                CHECK (family IN ('classification','nature','function','cash_flow')),

  -- Contra roles (accumulated depreciation, allowances) net against their
  -- parent line. Signed amounts do this automatically; the flag is for the UI.
  is_contra   boolean NOT NULL DEFAULT false,

  -- false = available but hidden behind "show all" in the tagging UI.
  is_core     boolean NOT NULL DEFAULT true,

  sort_order  int NOT NULL DEFAULT 0,
  description text,
  CHECK (family = 'cash_flow' OR category IS NOT NULL)
);
CREATE INDEX role_definition_family_idx ON role_definition (family, sort_order);

CREATE TABLE account_role (
  account_id uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  role       text NOT NULL REFERENCES role_definition(code),
  PRIMARY KEY (account_id, role)
);
CREATE INDEX account_role_role_idx ON account_role (role);

-- -----------------------------------------------------------------------------
-- 5. DIMENSIONS — analytical tags (what 辅助核算 is in Chinese ERP terms).
--    Adding a new dimension is inserting a row, never a schema migration.
-- -----------------------------------------------------------------------------
CREATE TABLE dimension (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id  uuid NOT NULL REFERENCES entity(id),
  code       text NOT NULL,                                      -- 'DEPARTMENT'
  name       text NOT NULL,
  is_active  boolean NOT NULL DEFAULT true,
  UNIQUE (entity_id, code)
);

CREATE TABLE dimension_value (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dimension_id uuid NOT NULL REFERENCES dimension(id) ON DELETE CASCADE,
  code         text NOT NULL,                                    -- 'SALES'
  name         text NOT NULL,
  parent_id    uuid REFERENCES dimension_value(id),
  is_active    boolean NOT NULL DEFAULT true,
  UNIQUE (dimension_id, code)
);

-- -----------------------------------------------------------------------------
-- 6. FISCAL CALENDAR — periods carry the lock that protects filed numbers.
--    'open'   : postable
--    'closed' : blocked, but can be reopened (logged)
--    'locked' : permanently blocked — use after a GST/HST or T2 filing
-- -----------------------------------------------------------------------------
CREATE TABLE fiscal_year (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_id  uuid NOT NULL REFERENCES ledger(id),
  name       text NOT NULL,                                      -- 'FY2026'
  start_date date NOT NULL,
  end_date   date NOT NULL,
  status     text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','locked')),
  UNIQUE (ledger_id, name),
  CHECK (end_date > start_date)
);

CREATE TABLE fiscal_period (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fiscal_year_id uuid NOT NULL REFERENCES fiscal_year(id) ON DELETE CASCADE,
  ledger_id      uuid NOT NULL REFERENCES ledger(id),   -- denormalized for fast lookup
  period_no      smallint NOT NULL CHECK (period_no BETWEEN 1 AND 13), -- 13 = year-end adjustments
  name           text NOT NULL,                                  -- '2026-01'
  start_date     date NOT NULL,
  end_date       date NOT NULL,
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','locked')),
  closed_at      timestamptz,
  closed_by      text,
  UNIQUE (fiscal_year_id, period_no),
  CHECK (end_date >= start_date)
);
CREATE INDEX fiscal_period_lookup_idx ON fiscal_period (ledger_id, start_date, end_date);

-- -----------------------------------------------------------------------------
-- 7. NUMBER SEQUENCE — gapless document numbering.
--    Postgres SEQUENCE is deliberately gap-prone (a rollback burns the number),
--    so document numbers use a locked row instead, allocated at commit time.
-- -----------------------------------------------------------------------------
CREATE TABLE number_sequence (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id   uuid NOT NULL REFERENCES entity(id),
  doc_type    text NOT NULL,                                     -- 'JE','INV','BILL'
  fiscal_year text NOT NULL,                                     -- 'FY2026'
  prefix      text NOT NULL DEFAULT '',                          -- 'JE-2026-'
  next_number bigint NOT NULL DEFAULT 1,
  padding     smallint NOT NULL DEFAULT 5,
  UNIQUE (entity_id, doc_type, fiscal_year)
);

-- -----------------------------------------------------------------------------
-- 8. JOURNAL ENTRY — the immutable core.
-- -----------------------------------------------------------------------------
CREATE TABLE journal_entry (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_id       uuid NOT NULL REFERENCES ledger(id),
  entry_no        text,                       -- NULL while draft; allocated at posting
  entry_date      date NOT NULL,
  period_id       uuid REFERENCES fiscal_period(id),
  description     text NOT NULL,
  memo            text,

  -- Where this entry came from. Manual journals are just one source among many;
  -- every subledger document (invoice, bill, payment, bank line) posts through
  -- the same function and lands here.
  source_type     text NOT NULL DEFAULT 'manual'
                    CHECK (source_type IN ('manual','opening_balance','ar_invoice',
                                           'ap_bill','payment','bank','period_close','adjustment')),
  source_id       uuid,

  status          text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','posted','reversed')),

  -- Correction linkage. An "edit" of a posted entry is reverse + repost:
  --   original.reversed_by_id -> reversal ; reversal.reverses_id -> original
  --   replacement.replaces_id -> original
  reverses_id     uuid REFERENCES journal_entry(id),
  reversed_by_id  uuid REFERENCES journal_entry(id),
  replaces_id     uuid REFERENCES journal_entry(id),
  void_reason     text,

  currency        char(3) NOT NULL DEFAULT 'CAD',
  total_debit     bigint NOT NULL DEFAULT 0,   -- cents, redundant; for fast display + sanity checks
  total_credit    bigint NOT NULL DEFAULT 0,

  -- Same key twice = same entry. Protects against double-clicks and re-imports.
  idempotency_key text UNIQUE,

  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      text NOT NULL DEFAULT 'system',
  posted_at       timestamptz,
  posted_by       text,

  CHECK (status <> 'posted' OR (entry_no IS NOT NULL AND period_id IS NOT NULL AND posted_at IS NOT NULL))
);
CREATE UNIQUE INDEX journal_entry_no_idx ON journal_entry (ledger_id, entry_no) WHERE entry_no IS NOT NULL;
CREATE INDEX journal_entry_date_idx   ON journal_entry (ledger_id, entry_date);
CREATE INDEX journal_entry_period_idx ON journal_entry (period_id);
CREATE INDEX journal_entry_source_idx ON journal_entry (source_type, source_id);

-- -----------------------------------------------------------------------------
-- 9. JOURNAL LINE
--
--    `amount` is the single source of truth: positive = debit, negative = credit.
--    This makes the balance invariant exactly "SUM(amount) = 0" — one number,
--    impossible to half-satisfy. debit/credit are generated columns so that
--    every report and screen can still speak in normal accounting terms.
-- -----------------------------------------------------------------------------
CREATE TABLE journal_line (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id    uuid NOT NULL REFERENCES journal_entry(id) ON DELETE CASCADE,
  line_no     smallint NOT NULL,
  account_id  uuid NOT NULL REFERENCES account(id),
  description text,

  amount      bigint NOT NULL CHECK (amount <> 0),               -- cents; + debit, - credit
  debit       bigint GENERATED ALWAYS AS (CASE WHEN amount > 0 THEN  amount ELSE 0 END) STORED,
  credit      bigint GENERATED ALWAYS AS (CASE WHEN amount < 0 THEN -amount ELSE 0 END) STORED,
  currency    char(3) NOT NULL DEFAULT 'CAD',

  -- {"DEPARTMENT":"SALES","PROJECT":"P001"} — validated against the registry
  -- by the posting service, queryable via the GIN index below.
  dimensions  jsonb NOT NULL DEFAULT '{}'::jsonb,

  UNIQUE (entry_id, line_no)
);
CREATE INDEX journal_line_account_idx ON journal_line (account_id);
CREATE INDEX journal_line_entry_idx   ON journal_line (entry_id);
CREATE INDEX journal_line_dim_idx     ON journal_line USING gin (dimensions);

-- -----------------------------------------------------------------------------
-- 10. PERIOD BALANCE — a CACHE, not the truth.
--     journal_line is the truth. This table can always be rebuilt from it
--     (see rebuild_period_balances below), so a bug here is never fatal.
-- -----------------------------------------------------------------------------
CREATE TABLE period_balance (
  ledger_id       uuid   NOT NULL REFERENCES ledger(id),
  period_id       uuid   NOT NULL REFERENCES fiscal_period(id) ON DELETE CASCADE,
  account_id      uuid   NOT NULL REFERENCES account(id),
  opening_balance bigint NOT NULL DEFAULT 0,   -- signed: + debit balance, - credit balance
  period_debit    bigint NOT NULL DEFAULT 0,
  period_credit   bigint NOT NULL DEFAULT 0,
  closing_balance bigint NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ledger_id, period_id, account_id)
);

-- -----------------------------------------------------------------------------
-- 11. AUDIT LOG — your black box recorder.
--     When a number looks wrong, this tells you which operation caused it.
-- -----------------------------------------------------------------------------
CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor       text NOT NULL DEFAULT 'system',
  action      text NOT NULL,          -- 'post','reverse','amend','close_period','reopen_period','hard_delete'
  table_name  text NOT NULL,
  record_id   text NOT NULL,
  before      jsonb,
  after       jsonb,
  context     jsonb                   -- entity/ledger/reason/request id
);
CREATE INDEX audit_log_record_idx ON audit_log (table_name, record_id, occurred_at DESC);
CREATE INDEX audit_log_time_idx   ON audit_log (occurred_at DESC);

-- -----------------------------------------------------------------------------
-- 12. STATEMENT TEMPLATES — how roles become financial statements.
--     One template per (standard, statement, language). Swap the template,
--     get a different presentation basis from the same ledger.
-- -----------------------------------------------------------------------------
CREATE TABLE statement_template (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                text NOT NULL UNIQUE,             -- 'ASPE_BS_EN'
  name                text NOT NULL,
  statement_type      text NOT NULL CHECK (statement_type IN ('balance_sheet','income_statement','cash_flow','trial_balance')),
  accounting_standard text NOT NULL REFERENCES accounting_standard(code),
  locale              text NOT NULL DEFAULT 'en-CA',
  is_active           boolean NOT NULL DEFAULT true
);

CREATE TABLE statement_line (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES statement_template(id) ON DELETE CASCADE,
  sort_order  int  NOT NULL,
  indent      smallint NOT NULL DEFAULT 0,
  code        text,                                     -- referenced by subtotal formulas
  label       text NOT NULL,
  -- header  : label only
  -- detail  : sum of accounts carrying any of `roles`
  -- total   : evaluate `formula` over other lines' `code`
  -- current_earnings : profit/loss of the fiscal year to date (all revenue and
  --           expense accounts). Without it a mid-year balance sheet does not
  --           balance, because retained earnings has not been closed yet.
  -- spacer  : blank row
  --
  -- CONVENTION: detail sums and formulas always operate on RAW signed values
  -- (debit +, credit -). `sign_flip` is applied only when rendering. That way
  -- TOTAL ASSETS + TOTAL LIABILITIES AND EQUITY = 0 is the balance check.
  line_type   text NOT NULL CHECK (line_type IN ('header','detail','total','current_earnings','spacer')),
  roles       text[] NOT NULL DEFAULT '{}',             -- detail lines: sum accounts carrying these roles

  -- WHICH NUMBER to pull. The balance sheet wants the closing balance;
  -- the income statement wants the movement during the period. Getting this
  -- wrong makes the P&L show cumulative-since-inception figures.
  value_basis text NOT NULL DEFAULT 'closing_balance'
                CHECK (value_basis IN ('closing_balance','period_movement')),
  formula     text,                                     -- total lines: e.g. 'CA + NCA' (references other lines' code)
  sign_flip   boolean NOT NULL DEFAULT false,           -- show liabilities/equity/revenue as positive
  UNIQUE (template_id, sort_order)
);

-- =============================================================================
-- TRIGGERS — the guarantees the application cannot bypass
-- =============================================================================

-- (a) Every POSTED entry balances. DEFERRED, so it is checked at COMMIT —
--     lines may be inserted in any order inside the transaction.
CREATE OR REPLACE FUNCTION assert_entry_balanced() RETURNS trigger AS $$
DECLARE
  v_status text;
  v_sum    bigint;
  v_id     uuid;
BEGIN
  v_id := COALESCE(NEW.entry_id, OLD.entry_id);
  SELECT status INTO v_status FROM journal_entry WHERE id = v_id;
  IF v_status IS NULL OR v_status = 'draft' THEN
    RETURN NULL;                                   -- drafts are allowed to be lopsided
  END IF;
  SELECT COALESCE(SUM(amount), 0) INTO v_sum FROM journal_line WHERE entry_id = v_id;
  IF v_sum <> 0 THEN
    RAISE EXCEPTION 'Journal entry % is out of balance by % cents', v_id, v_sum;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_line_balanced
  AFTER INSERT OR UPDATE OR DELETE ON journal_line
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_entry_balanced();

CREATE OR REPLACE FUNCTION assert_entry_balanced_on_header() RETURNS trigger AS $$
DECLARE v_sum bigint;
BEGIN
  IF NEW.status = 'draft' THEN RETURN NULL; END IF;
  SELECT COALESCE(SUM(amount), 0) INTO v_sum FROM journal_line WHERE entry_id = NEW.id;
  IF v_sum <> 0 THEN
    RAISE EXCEPTION 'Journal entry % is out of balance by % cents', NEW.id, v_sum;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM journal_line WHERE entry_id = NEW.id) THEN
    RAISE EXCEPTION 'Journal entry % has no lines', NEW.id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_entry_balanced
  AFTER INSERT OR UPDATE ON journal_entry
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_entry_balanced_on_header();

-- (b) Posted entries are immutable. Only the reversal linkage and the
--     posted -> reversed status transition may change.
CREATE OR REPLACE FUNCTION forbid_posted_entry_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'Cannot delete posted journal entry % — reverse it instead', OLD.id;
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status IN ('posted','reversed') THEN
    IF  NEW.ledger_id    IS DISTINCT FROM OLD.ledger_id
     OR NEW.entry_no     IS DISTINCT FROM OLD.entry_no
     OR NEW.entry_date   IS DISTINCT FROM OLD.entry_date
     OR NEW.period_id    IS DISTINCT FROM OLD.period_id
     OR NEW.currency     IS DISTINCT FROM OLD.currency
     OR NEW.total_debit  IS DISTINCT FROM OLD.total_debit
     OR NEW.total_credit IS DISTINCT FROM OLD.total_credit
     OR NEW.source_type  IS DISTINCT FROM OLD.source_type
     OR NEW.posted_at    IS DISTINCT FROM OLD.posted_at THEN
      RAISE EXCEPTION 'Posted journal entry % is immutable', OLD.id;
    END IF;
    IF NEW.status NOT IN ('posted','reversed') THEN
      RAISE EXCEPTION 'Posted journal entry % cannot return to %', OLD.id, NEW.status;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_entry_immutable
  BEFORE UPDATE OR DELETE ON journal_entry
  FOR EACH ROW EXECUTE FUNCTION forbid_posted_entry_mutation();

CREATE OR REPLACE FUNCTION forbid_posted_line_mutation() RETURNS trigger AS $$
DECLARE v_status text; v_id uuid;
BEGIN
  v_id := COALESCE(NEW.entry_id, OLD.entry_id);
  SELECT status INTO v_status FROM journal_entry WHERE id = v_id;
  -- NULL status = the parent entry is being cascade-deleted (draft only); allow.
  IF v_status IS NOT NULL AND v_status <> 'draft' THEN
    RAISE EXCEPTION 'Lines of posted journal entry % are immutable', v_id;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_line_immutable
  BEFORE UPDATE OR DELETE ON journal_line
  FOR EACH ROW EXECUTE FUNCTION forbid_posted_line_mutation();

-- (c) Nothing posts into a closed period. Checked here, not in the UI,
--     because CSV imports and scripts bypass the UI.
CREATE OR REPLACE FUNCTION assert_period_open() RETURNS trigger AS $$
DECLARE v_status text;
BEGIN
  IF NEW.status <> 'posted' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'posted' THEN RETURN NEW; END IF;  -- already posted
  SELECT status INTO v_status FROM fiscal_period WHERE id = NEW.period_id;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'No fiscal period covers % in this ledger', NEW.entry_date;
  END IF;
  IF v_status <> 'open' THEN
    RAISE EXCEPTION 'Fiscal period is % — cannot post entry dated %', v_status, NEW.entry_date;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_period_open
  BEFORE INSERT OR UPDATE ON journal_entry
  FOR EACH ROW EXECUTE FUNCTION assert_period_open();

-- (d) Only postable, active, same-entity accounts may receive lines.
CREATE OR REPLACE FUNCTION assert_account_postable() RETURNS trigger AS $$
DECLARE v_postable boolean; v_active boolean; v_acct_entity uuid; v_ledger_entity uuid;
BEGIN
  SELECT a.is_postable, a.is_active, a.entity_id
    INTO v_postable, v_active, v_acct_entity
    FROM account a WHERE a.id = NEW.account_id;

  SELECT l.entity_id INTO v_ledger_entity
    FROM journal_entry je JOIN ledger l ON l.id = je.ledger_id
   WHERE je.id = NEW.entry_id;

  IF v_acct_entity <> v_ledger_entity THEN
    RAISE EXCEPTION 'Account % belongs to a different entity than this ledger', NEW.account_id;
  END IF;
  IF NOT v_postable THEN
    RAISE EXCEPTION 'Account % is a header account and cannot be posted to', NEW.account_id;
  END IF;
  IF NOT v_active THEN
    RAISE EXCEPTION 'Account % is inactive', NEW.account_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_account_postable
  BEFORE INSERT ON journal_line
  FOR EACH ROW EXECUTE FUNCTION assert_account_postable();

-- =============================================================================
-- REBUILD — period_balance is a cache; this proves it.
-- Run it any time you suspect the balances drifted. It is always safe.
-- =============================================================================
CREATE OR REPLACE FUNCTION rebuild_period_balances(p_ledger_id uuid) RETURNS void AS $$
BEGIN
  DELETE FROM period_balance WHERE ledger_id = p_ledger_id;

  -- Every account that has EVER been posted to gets a row in EVERY period,
  -- not just the periods it moved in. Without the cross join, an account that
  -- is dormant for a month silently drops off the balance sheet from then on.
  INSERT INTO period_balance (ledger_id, period_id, account_id,
                              opening_balance, period_debit, period_credit, closing_balance)
  WITH periods AS (
    SELECT id, start_date FROM fiscal_period WHERE ledger_id = p_ledger_id
  ),
  accounts_used AS (
    SELECT DISTINCT jl.account_id
      FROM journal_entry je JOIN journal_line jl ON jl.entry_id = je.id
     WHERE je.ledger_id = p_ledger_id AND je.status IN ('posted','reversed')
  ),
  movements AS (
    SELECT je.period_id, jl.account_id,
           SUM(jl.debit)  AS d,
           SUM(jl.credit) AS c,
           SUM(jl.amount) AS m
      FROM journal_entry je JOIN journal_line jl ON jl.entry_id = je.id
     WHERE je.ledger_id = p_ledger_id AND je.status IN ('posted','reversed')
     GROUP BY je.period_id, jl.account_id
  ),
  grid AS (
    SELECT p.id AS period_id, p.start_date, a.account_id,
           COALESCE(m.d, 0) AS d, COALESCE(m.c, 0) AS c, COALESCE(m.m, 0) AS m
      FROM periods p
      CROSS JOIN accounts_used a
      LEFT JOIN movements m ON m.period_id = p.id AND m.account_id = a.account_id
  )
  SELECT p_ledger_id, g.period_id, g.account_id,
         COALESCE(SUM(g.m) OVER w, 0)              AS opening_balance,
         g.d, g.c,
         COALESCE(SUM(g.m) OVER w, 0) + g.m        AS closing_balance
    FROM grid g
  WINDOW w AS (PARTITION BY g.account_id ORDER BY g.start_date
               ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING);
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- Role definitions and IFRS statement templates are seeded separately:
--   docs/design/seed-ifrs.sql
-- =============================================================================
