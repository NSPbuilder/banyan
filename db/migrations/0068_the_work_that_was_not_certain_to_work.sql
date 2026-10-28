-- 0068 — SR&ED: the work that was not certain to work, and what it cost.
--
-- The owner's companies will claim the federal SR&ED credit and the BC one
-- (2026-09-10). What CRA examines is not the arithmetic — it is whether the
-- work was systematic investigation of a real uncertainty, and whether the
-- money claimed against it can be tied to records made AT THE TIME. So this
-- schema is mostly about evidence and about attribution; the money is derived
-- from the ledger that already holds it.
--
-- NOTHING HERE STORES AN AMOUNT. A claim's figures come from `pay_stub`,
-- `journal_line` and the rate table every time they are asked for. A claim
-- that disagrees with the books is worse than no claim.
--
-- THE RATES ARE DATA. Every percentage, multiple and threshold lives in
-- `sred_rate` with the provision it comes from and how sure the person who
-- entered it was. They change, and whoever changes them next should not have
-- to read TypeScript.

-- ---------------------------------------------------------------- facts --
--
-- Three things the claim needs that the books did not record, each a fact
-- about something that already exists rather than a setting on the claim.

-- Whether a company is a Canadian-controlled private corporation decides the
-- credit rate and whether it is refundable. NULL means nobody has said, and
-- the working paper refuses to guess.
ALTER TABLE entity ADD COLUMN is_ccpc boolean;
COMMENT ON COLUMN entity.is_ccpc IS
  'CCPC status: 35% enhanced, refundable, up to the expenditure limit. NULL = not stated.';

-- A contractor at arm's length has 80% of the contract counted; one that is
-- not is treated differently and this system does not attempt it.
ALTER TABLE party ADD COLUMN arms_length boolean NOT NULL DEFAULT true;
COMMENT ON COLUMN party.arms_length IS
  'False for a non-arm''s-length party: the 80% contract rule does not apply and the claim needs advice.';

-- A specified employee owns 10% or more of any class of shares, or does not
-- deal at arm's length with somebody who does. Their salary is capped and
-- profit-based pay is excluded. The securities register can suggest this; it
-- cannot settle it, because a relationship is not a shareholding.
ALTER TABLE payroll_employee ADD COLUMN is_specified boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN payroll_employee.is_specified IS
  'ITA 248(1) "specified employee": 5 x YMPE cap, no profit-based pay, 75% into the proxy base.';

-- --------------------------------------------------------------- rates --

CREATE TABLE sred_rate (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  jurisdiction  text NOT NULL CHECK (jurisdiction IN ('federal', 'BC')),
  name          text NOT NULL,
  value         numeric NOT NULL,
  effective_from date NOT NULL,
  effective_to   date,
  -- Where it comes from, and how sure the person who entered it was. A rate
  -- with no authority is a rate somebody remembered.
  authority     text NOT NULL,
  confidence    text NOT NULL CHECK (confidence IN ('confirmed', 'unconfirmed')),
  note          text,
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE UNIQUE INDEX sred_rate_one_at_a_time
  ON sred_rate (jurisdiction, name, effective_from);

-- ------------------------------------------------------------ projects --

CREATE TABLE sred_project (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id     uuid NOT NULL REFERENCES entity(id),
  code          text NOT NULL,
  title         text NOT NULL,
  -- The T661 field-of-science code. Text, because the list is CRA's and long.
  field_of_science text,
  started_on    date NOT NULL,
  ended_on      date,
  -- `abandoned` is not a failure to hide: work that did not resolve its
  -- uncertainty is still SR&ED, and claims are lost by not saying so.
  status        text NOT NULL DEFAULT 'active'
                CHECK (status IN ('planned', 'active', 'concluded', 'abandoned')),
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (ended_on IS NULL OR ended_on >= started_on)
);
CREATE UNIQUE INDEX sred_project_code ON sred_project (entity_id, code);

-- One project, one tax year, one claim. The narrative is here rather than in
-- a document because the audit trail then holds when each word was written —
-- which is the difference between contemporaneous and reconstructed.
CREATE TABLE sred_claim (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES sred_project(id) ON DELETE CASCADE,
  fiscal_year_id uuid NOT NULL REFERENCES fiscal_year(id),
  -- Chosen each year, and irrevocable for that year once filed.
  method        text NOT NULL DEFAULT 'proxy' CHECK (method IN ('proxy', 'traditional')),
  uncertainty_text text,     -- T661 line 242
  work_done_text   text,     -- T661 line 244
  advancement_text text,     -- T661 line 246
  -- Asked every year and answered every year: assistance and payments for the
  -- work reduce the claim, and this is the line CRA adjusts most often.
  assistance_answered_on date,
  assistance_note text,
  filed_on      date,
  filed_by      text,
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sred_claim_one_per_year ON sred_claim (project_id, fiscal_year_id);

-- ---------------------------------------------------------------- time --
--
-- The record CRA asks for first and the one nobody has. Kept by the day, and
-- `created_at` beside `on_date` is itself evidence: a week's work entered a
-- year later is worth less than the same hours entered that evening, and the
-- screen says so rather than pretending otherwise.

CREATE TABLE sred_time (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES sred_project(id) ON DELETE CASCADE,
  employee_id   uuid NOT NULL REFERENCES payroll_employee(id),
  on_date       date NOT NULL,
  hours         numeric(5,2) NOT NULL CHECK (hours > 0 AND hours <= 24),
  activity      text NOT NULL,
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sred_time_by_project ON sred_time (project_id, on_date);
CREATE INDEX sred_time_by_employee ON sred_time (employee_id, on_date);

-- --------------------------------------------------------- allocations --
--
-- One dollar, one claim, at most once — across every project and every year.
-- A percentage rather than a flag, because a person's fortnight is rarely all
-- one thing; and a reason beside it, because the percentage is what gets
-- asked about.

CREATE TABLE sred_allocation (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id      uuid NOT NULL REFERENCES sred_claim(id) ON DELETE CASCADE,
  source_kind   text NOT NULL CHECK (source_kind IN ('pay_stub', 'journal_line')),
  source_id     uuid NOT NULL,
  -- Which T661 bucket. Said by the person allocating rather than guessed from
  -- the chart: an account named "Supplies" holds both materials consumed in a
  -- trial and the paper in the printer.
  category      text NOT NULL
                CHECK (category IN ('salary', 'materials', 'contract',
                                    'third_party', 'overhead', 'capital')),
  percent       numeric(5,2) NOT NULL CHECK (percent > 0 AND percent <= 100),
  basis         text NOT NULL,
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sred_allocation_once_per_claim
  ON sred_allocation (claim_id, source_kind, source_id);
CREATE INDEX sred_allocation_by_source ON sred_allocation (source_kind, source_id);

-- THE SAME DOLLAR TWICE. Two projects may share a person's fortnight, and the
-- two percentages may not add to more than the fortnight. Enforced here
-- because it is the one rule a spreadsheet cannot hold and an auditor checks
-- first.
CREATE OR REPLACE FUNCTION check_sred_allocation_total() RETURNS trigger AS $$
DECLARE total numeric;
BEGIN
  SELECT COALESCE(SUM(percent), 0) INTO total
    FROM sred_allocation
   WHERE source_kind = NEW.source_kind AND source_id = NEW.source_id
     AND id <> NEW.id;
  IF total + NEW.percent > 100 THEN
    RAISE EXCEPTION 'SRED_OVER_ALLOCATED: % is already %%% claimed; % more would be over 100%%',
      NEW.source_kind, total, NEW.percent
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sred_allocation_total
  BEFORE INSERT OR UPDATE ON sred_allocation
  FOR EACH ROW EXECUTE FUNCTION check_sred_allocation_total();

-- A claim may only reach money that is POSTED. A draft is not a cost and a
-- reversed entry is not one either; both would inflate a claim silently.
CREATE OR REPLACE FUNCTION check_sred_allocation_source() RETURNS trigger AS $$
DECLARE ok boolean;
BEGIN
  IF NEW.source_kind = 'journal_line' THEN
    SELECT je.status = 'posted' INTO ok
      FROM journal_line jl JOIN journal_entry je ON je.id = jl.entry_id
     WHERE jl.id = NEW.source_id;
  ELSE
    SELECT je.status = 'posted' INTO ok
      FROM pay_stub ps JOIN pay_run pr ON pr.id = ps.pay_run_id
      JOIN journal_entry je ON je.id = pr.entry_id
     WHERE ps.id = NEW.source_id;
  END IF;
  IF ok IS NULL THEN
    RAISE EXCEPTION 'SRED_NO_SOURCE: there is no % with that id', NEW.source_kind
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT ok THEN
    RAISE EXCEPTION 'SRED_NOT_POSTED: only posted money can be claimed; that one is not'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sred_allocation_source
  BEFORE INSERT OR UPDATE ON sred_allocation
  FOR EACH ROW EXECUTE FUNCTION check_sred_allocation_source();

-- ------------------------------------------------------------ evidence --
--
-- CRA's own list of what supports a claim, as a controlled vocabulary, each
-- item pointing at paper this system already holds.

CREATE TABLE sred_evidence (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES sred_project(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN (
                  'plan', 'hypothesis', 'trial_record', 'analysis', 'notebook',
                  'source_code', 'progress_report', 'meeting_minutes',
                  'contract', 'invoice', 'scrap_record', 'photo', 'final_report')),
  title         text NOT NULL,
  on_date       date NOT NULL,
  attachment_id uuid REFERENCES attachment(id) ON DELETE SET NULL,
  note          text,
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sred_evidence_by_project ON sred_evidence (project_id, on_date);

-- ----------------------------------------------------------- the rates --
--
-- What I believe to be true on 2026-09-10, with the provision each comes from
-- and whether I am sure. `unconfirmed` is not a hedge: it is a list for the
-- person filing to check, and the working paper prints it.

INSERT INTO sred_rate (jurisdiction, name, value, effective_from, authority, confidence, note) VALUES
  ('federal', 'enhanced_itc',            0.35,    '2014-01-01', 'ITA 127(10.1)', 'confirmed',
   'CCPC, on qualified expenditures up to the expenditure limit. Refundable.'),
  ('federal', 'basic_itc',               0.15,    '2014-01-01', 'ITA 127(9) "investment tax credit"', 'confirmed',
   'Above the limit, and for a non-CCPC. Generally not refundable.'),
  ('federal', 'expenditure_limit', 3000000,       '2014-01-01', 'ITA 127(10.2)', 'unconfirmed',
   'Ground down by taxable capital between $10M and $50M. A 2024 proposal to raise this to $4.5M may or may not be law — CHECK BEFORE FILING.'),
  ('federal', 'proxy_percent',           0.55,    '2014-01-01', 'ITR 2900(4)', 'confirmed',
   'The prescribed proxy amount, on the salary base of employees directly engaged in Canada.'),
  ('federal', 'contract_arms_length_percent', 0.80, '2013-01-01', 'ITA 127(9) "qualified expenditure"', 'confirmed',
   'Of an arm''s-length contract for SR&ED performed in Canada.'),
  ('federal', 'specified_employee_ympe_multiple', 5, '2014-01-01', 'ITA 37(9.1)', 'confirmed',
   'Salary of a specified employee counts up to 5 x YMPE for the year, prorated for a short year.'),
  ('federal', 'specified_employee_ppa_percent', 0.75, '2014-01-01', 'ITR 2900(9)', 'unconfirmed',
   'The share of a specified employee''s salary that enters the proxy base. Confirm the current wording.'),
  ('federal', 'capital_eligible',        0,       '2014-01-01', 'ITA 37(1)(b), repealed', 'confirmed',
   'Capital expenditures have not been eligible federally since 2014. A 2024 proposal would restore them — CHECK.'),
  ('federal', 'reporting_deadline_months', 18,    '2014-01-01', 'ITA 37(11)', 'confirmed',
   'From the tax year end. Missing it loses the claim entirely; there is no relief.'),
  ('BC',      'itc_percent',             0.10,    '2014-01-01', 'BC Income Tax Act s.97', 'confirmed',
   'Refundable for a CCPC on qualified BC expenditures up to the expenditure limit.'),
  ('BC',      'claim_deadline_months',   18,      '2014-01-01', 'BC Income Tax Act s.99', 'confirmed',
   'From the tax year end, same as the federal reporting deadline.');
