-- 0031 — tax on an invoice is an ordinary line, pointed the right way
--
-- Why: docs/design/09-invoices.md, 「税：一条普通的行」.
--
-- There is no schema change for tax and there does not need to be. The PRD
-- freezes automatic calculation as a non-goal — the figure is typed — so the
-- only question `09` left open was WHERE the typed figure lives. A field on
-- `invoice_line` would be a second place amounts are held, and `tax.ts` would
-- then need to know about invoices. A LINE costs nothing: it posts as an
-- ordinary journal line, and `gstHstReturn` already reads the ledger by
-- `account_role`, so the return picks it up without a word of new code.
--
-- What DOES need a guard is which way the line points.
--
-- Tax collected on a sale is a LIABILITY (`gst_hst_payable`); tax paid on a
-- purchase is usually RECOVERABLE (`gst_hst_recoverable`, an input tax credit).
-- They are different boxes on the return — line 105 and line 108 — and putting
-- a sale's tax in the recoverable account means claiming back tax you charged
-- somebody else. The entry balances. The trial balance balances. The return is
-- wrong in both directions at once, by twice the figure.
--
-- BC PST paid on a purchase is deliberately NOT in this rule: it is not
-- recoverable, so it carries no tax role at all and is simply an expense. See
-- `04-sales-tax-registration.md`.

CREATE OR REPLACE FUNCTION check_invoice_tax_side() RETURNS trigger AS $$
DECLARE
  inv       invoice%ROWTYPE;
  bad_code  text;
  bad_name  text;
  bad_role  text;
  wrong_way text;
BEGIN
  SELECT * INTO inv FROM invoice WHERE id = NEW.invoice_id;
  IF inv.id IS NULL THEN RETURN NULL; END IF;

  wrong_way := CASE WHEN inv.direction = 'sales' THEN '_recoverable' ELSE '_payable' END;

  SELECT a.code, a.name, ar.role INTO bad_code, bad_name, bad_role
    FROM account a
    JOIN account_role ar ON ar.account_id = a.id
   WHERE a.id = NEW.account_id
     AND ar.role LIKE '%' || wrong_way
     AND (ar.role LIKE 'gst%' OR ar.role LIKE 'qst%')
   LIMIT 1;

  IF bad_code IS NOT NULL THEN
    RAISE EXCEPTION 'TAX_WRONG_SIDE: % % is %, which is the other side of the return; a % invoice collects tax rather than reclaiming it',
      bad_code, bad_name, replace(bad_role, '_', ' '), inv.direction;
  END IF;

  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_invoice_tax_side
  AFTER INSERT OR UPDATE ON invoice_line
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_invoice_tax_side();
