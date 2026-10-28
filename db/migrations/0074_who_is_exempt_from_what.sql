-- WHO IS EXEMPT FROM WHAT.
--
-- An owner who controls more than 40% of the voting shares is not in
-- insurable employment (EIA 5(2)(b)), so no EI is withheld from them and none
-- is remitted; an employee over 70, or one who has filed a CPT30 election, is
-- exempt from CPP. Until now the payroll record could not say either, the
-- engine withheld both from everyone, and the T4 had no box 28 to declare it
-- on (whole-project audit, 2026-09-13). These are a person's answers about a
-- person, not derivations — the share register could settle the 40% question
-- for a shareholder and nothing here settles a CPT30 — so they are two flags
-- on the payroll record, off by default: the ordinary employee is exempt from
-- nothing.
ALTER TABLE payroll_employee
  ADD COLUMN cpp_exempt boolean NOT NULL DEFAULT false,
  ADD COLUMN ei_exempt  boolean NOT NULL DEFAULT false;
