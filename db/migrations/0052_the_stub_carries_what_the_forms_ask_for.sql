-- 0052 — the stub carries what the forms ask for, and stops carrying what it
--        cannot honour
--
-- Laying the T4 boxes and the ROE blocks out beside the columns showed two
-- things: one figure the forms need and nothing records, and two fields this
-- module offers and does not actually apply.
--
-- WHAT IS ADDED
--
-- HOURS. ROE Block 15A is total insurable HOURS, and it is the number the whole
-- form exists to establish — a summary without it would be decorative. Nothing
-- here has ever recorded hours: CRA's formulas are on earnings, so the engine
-- does not want them and no other screen asks. They are optional per pay line,
-- and only the ROE reads them.
--
-- Stored in HUNDREDTHS OF AN HOUR for the same reason money is in cents: 37.5
-- hours is 3750, the arithmetic stays integer, nothing rounds behind anyone's
-- back, and the ROE reports hours to two decimals.
--
-- OCCUPATION joins the employee record for the reason the SIN did: ROE Block 13
-- asks, and nothing else in the framework holds it.
--
-- WHAT IS REMOVED, and why it matters
--
-- `rpp_rrsp` and `union_dues` were standing per-period amounts on the employee
-- record. The engine subtracts them from income BEFORE annualising — that is
-- T4127's F and U1, and it is correct — and then computes
--
--     net pay = gross - CPP - CPP2 - EI - income tax
--
-- which does NOT take them off the pay. So an employee with $50 of union dues
-- had their tax reduced as though the dues had been withheld, and the $50 never
-- left their cheque: the company kept the tax saving and the union got nothing.
-- The project this engine was ported from does the same thing (`engine.py`:
-- `net = income - cpp.total - ei - income_tax`), so the port was faithful to a
-- defect rather than introducing one.
--
-- Withholding them properly is not a line of arithmetic — it is a payable to
-- somebody who is not CRA, which means an account, a line on the entry, and a
-- remittance that is not the PD7A. That is its own node. Until then the module
-- must not offer a field it does not honour: a wrong net pay is the one thing
-- an employee always notices, and a wrong T4 box 20 is the one CRA notices.
--
-- The engine keeps its `rppRrsp` and `unionDues` inputs — they are T4127's own,
-- and the day the withholding is built they are already there. Nothing can set
-- them today, which is the point. Every existing row is the default 0, so no
-- figure anywhere changes.

ALTER TABLE payroll_employee DROP COLUMN rpp_rrsp;
ALTER TABLE payroll_employee DROP COLUMN union_dues;
ALTER TABLE payroll_employee ADD COLUMN occupation text;

COMMENT ON COLUMN payroll_employee.occupation IS
  'ROE Block 13. Free text: Service Canada asks what the person did, not a code.';

ALTER TABLE pay_stub ADD COLUMN hours bigint NOT NULL DEFAULT 0 CHECK (hours >= 0);

COMMENT ON COLUMN pay_stub.hours IS
  'Insurable hours in hundredths — 3750 is 37.5 hours. ROE Block 15A. Zero means none was recorded.';
