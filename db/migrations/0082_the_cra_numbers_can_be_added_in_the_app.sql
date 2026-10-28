-- 0082 — the CRA numbers can be added in the app.
--
-- The owner (2026-09-16): 「payroll 的 T4127 具体数据我在 app 里看不到，如果有新
-- 的 t4127 了，我如何告诉 app」. The editions were code (src/lib/payroll/rates.ts,
-- design doc 35), so a new one meant a release. Those stay, as the editions
-- built in; one added on the payroll screen is a row here, and joins the list
-- after them.
--
-- The figures travel as the same JSON shapes the code writes (`CppEiRates`,
-- `FederalRates`, `BcRates`), so one parser reads both and one checker
-- (`rates-check.ts`) judges both. A row is refused before it is written unless
-- its numbers agree with themselves AND one PDOC case computed with them
-- matches what CRA's calculator said — the case is kept on the row, so what
-- the edition was proved against is on record.
--
-- Not one company's data: the law, like `sred_rate`, and so not in a company
-- backup file. The daily whole-database backup (docs/RESTORE.md) carries it.

CREATE TABLE payroll_rate_edition (
  id          text PRIMARY KEY CHECK (id ~ '^[0-9]{4}-[0-9]{2}$'),
  starts_on   date NOT NULL UNIQUE,
  authority   text NOT NULL CHECK (authority ~ '[^[:space:]]'),
  cpp_ei      jsonb NOT NULL,
  federal     jsonb NOT NULL,
  bc          jsonb NOT NULL,
  -- The PDOC case the edition was proved against before it was saved.
  pdoc        jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text NOT NULL,
  -- An edition's id names the month it starts in.
  CHECK (to_char(starts_on, 'YYYY-MM') = id)
);

COMMENT ON TABLE payroll_rate_edition IS
  'CRA T4127 editions added in the app, after the ones built into rates.ts. Proved against a PDOC case '
  'before saving; removable only while no pay stub was computed with it (0082).';
