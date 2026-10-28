-- FX is part of the base. Existing amounts and currency columns remain functional.
CREATE TABLE fx_currency (
  code text PRIMARY KEY CHECK(code ~ '^[A-Z]{3}$'),
  name text NOT NULL,
  minor_digits smallint NOT NULL CHECK(minor_digits BETWEEN 0 AND 3),
  boc_series text UNIQUE CHECK(boc_series ~ '^FX[A-Z]{3}CAD$'),
  historical boolean NOT NULL DEFAULT false
);
INSERT INTO fx_currency(code,name,minor_digits,boc_series,historical) VALUES
('CAD', 'Canadian dollar', 2, NULL, false),
('AUD', 'Daily average exchange rate of the Australian dollar in Canadian dollars.', 2, 'FXAUDCAD', false),
('BRL', 'Daily average exchange rate of the Brazilian real in Canadian dollars.', 2, 'FXBRLCAD', false),
('CNY', 'Daily average exchange rate of the Chinese renminbi in Canadian dollars.', 2, 'FXCNYCAD', false),
('EUR', 'Daily average exchange rate of the euro in Canadian dollars.', 2, 'FXEURCAD', false),
('HKD', 'Daily average exchange rate of the Hong Kong dollar in Canadian dollars.', 2, 'FXHKDCAD', false),
('INR', 'Daily average exchange rate of the Indian rupee in Canadian dollars.', 2, 'FXINRCAD', false),
('IDR', 'Daily average exchange rate of the Indonesian rupiah in Canadian dollars.', 2, 'FXIDRCAD', false),
('JPY', 'Daily average exchange rate of the Japanese yen in Canadian dollars.', 0, 'FXJPYCAD', false),
('MYR', 'Daily average exchange rate of the Malaysian ringgit in Canadian dollars.', 2, 'FXMYRCAD', false),
('MXN', 'Daily average exchange rate of the Mexican peso in Canadian dollars.', 2, 'FXMXNCAD', false),
('NZD', 'Daily average exchange rate of the New Zealand dollar in Canadian dollars.', 2, 'FXNZDCAD', false),
('NOK', 'Daily average exchange rate of the Norwegian krone in Canadian dollars.', 2, 'FXNOKCAD', false),
('PEN', 'Daily average exchange rate of the Peruvian new sol in Canadian dollars.', 2, 'FXPENCAD', false),
('RUB', 'Daily average exchange rate — historical series of the Russian ruble in Canadian dollars.', 2, 'FXRUBCAD', true),
('SAR', 'Daily average exchange rate — historical series of the Saudi riyal in Canadian dollars.', 2, 'FXSARCAD', true),
('SGD', 'Daily average exchange rate of the Singapore dollar in Canadian dollars.', 2, 'FXSGDCAD', false),
('ZAR', 'Daily average exchange rate of the South African rand in Canadian dollars.', 2, 'FXZARCAD', false),
('KRW', 'Daily average exchange rate of the South Korean won in Canadian dollars.', 0, 'FXKRWCAD', false),
('SEK', 'Daily average exchange rate of the Swedish krona in Canadian dollars.', 2, 'FXSEKCAD', false),
('CHF', 'Daily average exchange rate of the Swiss franc in Canadian dollars.', 2, 'FXCHFCAD', false),
('TWD', 'Daily average exchange rate of the Taiwanese dollar in Canadian dollars.', 2, 'FXTWDCAD', false),
('THB', 'Daily average exchange rate of the Thai baht in Canadian dollars.', 2, 'FXTHBCAD', false),
('TRY', 'Daily average exchange rate of the Turkish lira in Canadian dollars.', 2, 'FXTRYCAD', false),
('GBP', 'Daily average exchange rate of the UK pound sterling in Canadian dollars.', 2, 'FXGBPCAD', false),
('USD', 'Daily average exchange rate of the US dollar in Canadian dollars.', 2, 'FXUSDCAD', false),
('VND', 'Daily average exchange rate — historical series of the Vietnamese dong in Canadian dollars.', 0, 'FXVNDCAD', true),
('PLN', 'Daily average exchange rate of the Polish zloty in Canadian dollars.', 2, 'FXPLNCAD', false);
CREATE TABLE fx_company_currency (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES entity(id),
  currency text NOT NULL REFERENCES fx_currency(code),
  enabled boolean NOT NULL DEFAULT true,
  changed_at timestamptz NOT NULL DEFAULT now(),
  changed_by text NOT NULL,
  UNIQUE(entity_id,currency)
);
CREATE TABLE fx_rate (
  currency text NOT NULL REFERENCES fx_currency(code),
  observed_on date NOT NULL,
  rate numeric(21,12) NOT NULL CHECK(rate>0),
  source text NOT NULL CHECK(source='BOC'),
  reference text NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(currency,observed_on)
);
ALTER TABLE account ADD COLUMN foreign_currency text REFERENCES fx_currency(code);
ALTER TABLE invoice ADD COLUMN fx_currency text REFERENCES fx_currency(code), ADD COLUMN fx_snapshot jsonb,
  ADD COLUMN fx_request_key text;
CREATE UNIQUE INDEX fx_invoice_request_key ON invoice(ledger_id,fx_request_key) WHERE fx_request_key IS NOT NULL;
ALTER TABLE invoice_line ADD COLUMN original_amount bigint;
ALTER TABLE invoice_application ADD COLUMN original_amount bigint CHECK(original_amount>0),
  ADD COLUMN carrying_amount bigint CHECK(carrying_amount>=0);
ALTER TABLE journal_line ADD COLUMN original_currency text REFERENCES fx_currency(code),
  ADD COLUMN original_amount bigint, ADD COLUMN fx_snapshot jsonb,
  ADD COLUMN fx_invoice_id uuid REFERENCES invoice(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE journal_line DROP CONSTRAINT journal_line_amount_check;
ALTER TABLE journal_line ADD CONSTRAINT journal_line_amount_check CHECK(amount<>0 OR COALESCE(original_amount<>0,false));
ALTER TABLE invoice_application DROP CONSTRAINT invoice_application_amount_check;
ALTER TABLE invoice_application ADD CONSTRAINT invoice_application_amount_check CHECK(amount>0 OR
 (amount=0 AND COALESCE(original_amount>0,false) AND carrying_amount=0));
CREATE INDEX journal_line_fx_invoice_idx ON journal_line(fx_invoice_id) WHERE fx_invoice_id IS NOT NULL;
ALTER TABLE journal_entry DROP CONSTRAINT journal_entry_source_type_check;
ALTER TABLE journal_entry ADD CONSTRAINT journal_entry_source_type_check CHECK(source_type IN
 ('manual','opening_balance','ar_invoice','ap_bill','payment','bank','period_close','adjustment',
  'quick_expense','quick_income','payroll','fixed_asset','asset_depreciation','asset_deferred_tax',
  'inventory','production','operations_opening','fx_revaluation','fx_transfer'));

CREATE FUNCTION fx_snapshot_valid(s jsonb,c text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT COALESCE(jsonb_typeof(s)='object' AND s->>'currency'=c
   AND s->>'source' IN ('BOC','manual','carrying')
   AND s->>'rate' ~ '^[0-9]{1,9}([.][0-9]{1,12})?$'
   AND ((s->>'rate')::numeric>0 OR (s->>'source'='carrying' AND (s->>'rate')::numeric=0)) AND length(btrim(s->>'reference')) BETWEEN 1 AND 1000
   AND s->>'observedOn' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$',false)
$$;
ALTER TABLE invoice ADD CONSTRAINT fx_invoice_shape CHECK
 ((fx_currency IS NULL AND fx_snapshot IS NULL) OR
  (fx_currency<>'CAD' AND fx_snapshot_valid(fx_snapshot,fx_currency)));
ALTER TABLE journal_line ADD CONSTRAINT fx_line_shape CHECK
 ((original_currency IS NULL AND original_amount IS NULL AND fx_snapshot IS NULL AND fx_invoice_id IS NULL) OR
  (original_currency<>'CAD' AND original_amount IS NOT NULL AND fx_snapshot_valid(fx_snapshot,original_currency)));

CREATE FUNCTION fx_invoice_at(wanted uuid,as_of date DEFAULT 'infinity'::date)
 RETURNS TABLE(native_balance bigint,carrying_balance bigint) LANGUAGE sql STABLE AS $$
 SELECT COALESCE(sum(j.original_amount),0)::bigint,COALESCE(sum(j.amount),0)::bigint
 FROM journal_line j JOIN journal_entry e ON e.id=j.entry_id
 WHERE j.fx_invoice_id=wanted AND e.status IN ('posted','reversed') AND e.entry_date<=as_of
$$;

CREATE FUNCTION fx_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='ledger' THEN
  IF NEW.currency IS DISTINCT FROM OLD.currency AND EXISTS(SELECT 1 FROM journal_entry WHERE ledger_id=OLD.id) THEN
   RAISE EXCEPTION 'FX_FUNCTIONAL_LOCKED: a ledger with entries keeps its functional currency';
  END IF;
 ELSIF TG_TABLE_NAME='entity' THEN
  IF NEW.functional_currency IS DISTINCT FROM OLD.functional_currency AND EXISTS
   (SELECT 1 FROM journal_entry e JOIN ledger l ON l.id=e.ledger_id WHERE l.entity_id=OLD.id) THEN
   RAISE EXCEPTION 'FX_FUNCTIONAL_LOCKED: posted history requires a separate functional-currency change process';
  END IF;
 ELSIF TG_TABLE_NAME='account' THEN
  IF NEW.foreign_currency IS DISTINCT FROM OLD.foreign_currency THEN
   PERFORM pg_advisory_xact_lock(hashtextextended('bank_account:'||OLD.id,0));
   IF EXISTS(SELECT 1 FROM journal_line WHERE account_id=OLD.id)
    OR EXISTS(SELECT 1 FROM bank_transaction WHERE account_id=OLD.id)
    OR EXISTS(SELECT 1 FROM bank_statement WHERE account_id=OLD.id) THEN
    RAISE EXCEPTION 'FX_ACCOUNT_LOCKED: currency cannot change after account history exists';
   END IF;
   IF NEW.foreign_currency IS NOT NULL AND
     NOT EXISTS(SELECT 1 FROM account_role WHERE account_id=OLD.id AND role='cash_and_cash_equivalents') THEN
    RAISE EXCEPTION 'FX_ACCOUNT_ROLE: bind foreign currency to a cash/bank account';
   END IF;
  END IF;
 ELSE
  IF OLD.fx_currency IS DISTINCT FROM NEW.fx_currency OR OLD.fx_snapshot IS DISTINCT FROM NEW.fx_snapshot THEN
   IF OLD.status<>'draft' OR OLD.fx_currency IS NOT NULL THEN
    RAISE EXCEPTION 'FX_DOCUMENT_LOCKED: preserve the original document currency and rate';
   END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER fx_ledger_binding BEFORE UPDATE ON ledger FOR EACH ROW EXECUTE FUNCTION fx_binding_guard();
CREATE TRIGGER fx_entity_binding BEFORE UPDATE ON entity FOR EACH ROW EXECUTE FUNCTION fx_binding_guard();
CREATE TRIGGER fx_account_binding BEFORE UPDATE ON account FOR EACH ROW EXECUTE FUNCTION fx_binding_guard();
CREATE TRIGGER fx_invoice_binding BEFORE UPDATE ON invoice FOR EACH ROW EXECUTE FUNCTION fx_binding_guard();

CREATE FUNCTION fx_validate_line(line_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE item journal_line%ROWTYPE; e record; a record; i record; enabled boolean; maintenance boolean; previous bigint; movement bigint;
BEGIN
 SELECT * INTO item FROM journal_line WHERE id=line_id;
 IF item.id IS NULL THEN RETURN; END IF;
 SELECT * INTO e FROM journal_entry WHERE id=item.entry_id;
 IF e.id IS NULL THEN RETURN; END IF;
 SELECT ac.*,l.currency AS functional FROM account ac JOIN ledger l ON l.id=e.ledger_id WHERE ac.id=item.account_id INTO a;
 IF a.foreign_currency IS NOT NULL AND e.status<>'draft' AND
   (item.original_currency IS DISTINCT FROM a.foreign_currency OR item.original_amount IS NULL) THEN
   RAISE EXCEPTION 'FX_BANK_NATIVE: foreign bank lines require native amounts in the bound currency';
 END IF;
 IF item.original_currency IS NULL THEN RETURN; END IF;
 IF a.foreign_currency IS NULL AND EXISTS(SELECT 1 FROM account_role WHERE account_id=a.id AND role='cash_and_cash_equivalents') THEN
  RAISE EXCEPTION 'FX_BANK_NATIVE: native currency must match the bank account binding';
 END IF;
 IF item.fx_invoice_id IS NULL AND EXISTS(SELECT 1 FROM account_role WHERE account_id=a.id AND role IN ('trade_receivables','trade_payables')) THEN
  RAISE EXCEPTION 'FX_INVOICE_SCOPE: foreign control balances must identify their document';
 END IF;
 IF (item.fx_snapshot->>'observedOn')::date>e.entry_date THEN RAISE EXCEPTION 'FX_RATE_DATE: saved evidence cannot follow the entry date'; END IF;
 IF item.original_amount<>0 AND item.amount<>0 AND sign(item.original_amount)<>sign(item.amount) THEN
  RAISE EXCEPTION 'FX_NATIVE_SIGN: native and functional amounts must move together';
 END IF;
 IF item.fx_snapshot->>'source'<>'carrying' AND item.original_amount<>0 AND item.fx_invoice_id IS NULL AND e.reverses_id IS NULL
   AND item.amount IS DISTINCT FROM round(item.original_amount::numeric*(item.fx_snapshot->>'rate')::numeric*100 /
     power(10,(SELECT minor_digits FROM fx_currency WHERE code=item.original_currency)))::bigint THEN
  RAISE EXCEPTION 'FX_CONVERSION: native quantity and rate must agree with functional money';
 END IF;
 IF a.functional<>'CAD' THEN RAISE EXCEPTION 'FX_FUNCTIONAL: new FX workflows require CAD functional books'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('fx:'||e.ledger_id,0));
 IF item.fx_invoice_id IS NOT NULL THEN
  SELECT * INTO i FROM invoice WHERE id=item.fx_invoice_id;
  IF i.ledger_id IS DISTINCT FROM e.ledger_id OR i.control_account_id IS DISTINCT FROM item.account_id
    OR i.party_id IS DISTINCT FROM item.party_id OR i.fx_currency IS DISTINCT FROM item.original_currency THEN
   RAISE EXCEPTION 'FX_INVOICE_SCOPE: foreign control lines must belong to their document';
  END IF;
 END IF;
 IF e.status='draft' THEN RETURN; END IF;
 IF EXISTS(SELECT 1 FROM journal_line later_line JOIN journal_entry later_entry ON later_entry.id=later_line.entry_id
   WHERE later_entry.ledger_id=e.ledger_id AND later_entry.id<>e.id AND later_entry.status IN ('posted','reversed')
     AND later_entry.entry_date>e.entry_date AND ((item.fx_invoice_id IS NOT NULL AND later_line.fx_invoice_id=item.fx_invoice_id)
       OR (a.foreign_currency IS NOT NULL AND later_line.account_id=a.id AND later_line.original_currency IS NOT NULL))) THEN
  RAISE EXCEPTION 'FX_LATER_ACTIVITY: later foreign positions depend on their existing carrying cost';
 END IF;
 -- Reversals carry the original units, evidence and position identity exactly.
 maintenance:=false;
 IF e.reverses_id IS NOT NULL THEN
  SELECT EXISTS(SELECT 1 FROM journal_line prior_line WHERE prior_line.entry_id=e.reverses_id AND prior_line.line_no=item.line_no
   AND prior_line.account_id=item.account_id AND prior_line.party_id IS NOT DISTINCT FROM item.party_id
    AND prior_line.original_currency=item.original_currency AND prior_line.original_amount=-item.original_amount
   AND prior_line.amount=-item.amount AND prior_line.fx_invoice_id IS NOT DISTINCT FROM item.fx_invoice_id
   AND prior_line.fx_snapshot=item.fx_snapshot) INTO maintenance;
  IF NOT maintenance THEN RAISE EXCEPTION 'FX_REVERSAL: a correction must preserve the original currency evidence'; END IF;
 ELSIF e.source_type='payment' THEN
  SELECT EXISTS(SELECT 1 FROM journal_line jl JOIN invoice inv ON inv.id=jl.fx_invoice_id
   WHERE jl.entry_id=e.id AND inv.status='posted' AND inv.issued_on<=e.entry_date) INTO maintenance;
 ELSIF e.source_type='fx_revaluation' THEN
  IF item.original_amount<>0 OR (item.fx_invoice_id IS NULL AND a.foreign_currency IS NULL) THEN
   RAISE EXCEPTION 'FX_REVALUE_QUANTITY: revaluation must preserve a monetary position quantity';
  END IF;
  maintenance:=true;
 END IF;
 IF NOT maintenance THEN
  SELECT c.enabled INTO enabled FROM fx_company_currency c WHERE c.entity_id=a.entity_id AND c.currency=item.original_currency FOR SHARE;
  IF NOT COALESCE(enabled,false) THEN
   -- Disposal of an existing stopped-currency bank balance remains possible.
   SELECT COALESCE(sum(j.original_amount),0)::bigint INTO previous FROM journal_line j JOIN journal_entry je ON je.id=j.entry_id
    JOIN account cash ON cash.id=j.account_id WHERE cash.foreign_currency=item.original_currency AND je.ledger_id=e.ledger_id
      AND je.status IN ('posted','reversed') AND je.id<>e.id;
   SELECT COALESCE(sum(j.original_amount),0)::bigint INTO movement FROM journal_line j JOIN account cash ON cash.id=j.account_id
    WHERE j.entry_id=e.id AND cash.foreign_currency=item.original_currency;
   IF NOT (a.foreign_currency=item.original_currency AND e.source_type='fx_transfer'
     AND abs(previous+movement)<=abs(previous)) THEN
    RAISE EXCEPTION 'FX_STOPPED: this currency is stopped for new business';
   END IF;
  END IF;
 END IF;
 RETURN;
END $$;
-- Shared by live reversal posting and trigger-disabled portable restore.
CREATE FUNCTION fx_validate_reversal(wanted uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE prior uuid;
BEGIN
 SELECT reverses_id INTO prior FROM journal_entry WHERE id=wanted;
 IF prior IS NULL OR NOT EXISTS(SELECT 1 FROM journal_line WHERE entry_id IN (wanted,prior) AND original_currency IS NOT NULL) THEN RETURN; END IF;
 IF EXISTS(SELECT 1 FROM
   (SELECT * FROM journal_line WHERE entry_id=prior) p FULL JOIN
   (SELECT * FROM journal_line WHERE entry_id=wanted) n ON n.line_no=p.line_no
   WHERE p.id IS NULL OR n.id IS NULL OR p.account_id IS DISTINCT FROM n.account_id
     OR p.party_id IS DISTINCT FROM n.party_id OR p.amount IS DISTINCT FROM -n.amount
     OR p.original_currency IS DISTINCT FROM n.original_currency OR p.original_amount IS DISTINCT FROM -n.original_amount
     OR p.fx_snapshot IS DISTINCT FROM n.fx_snapshot OR p.fx_invoice_id IS DISTINCT FROM n.fx_invoice_id
     OR p.dimensions IS DISTINCT FROM n.dimensions) THEN
  RAISE EXCEPTION 'FX_REVERSAL: a foreign reversal must be an exact mirror of every original line';
 END IF;
END $$;
CREATE FUNCTION fx_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM fx_validate_line(NEW.id); PERFORM fx_validate_reversal(NEW.entry_id); RETURN NULL; END $$;
CREATE FUNCTION fx_entry_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE line_id uuid;
BEGIN
 IF NEW.status<>'draft' AND (TG_OP='INSERT' OR OLD.status='draft') THEN
  PERFORM fx_validate_reversal(NEW.id);
  FOR line_id IN SELECT id FROM journal_line WHERE entry_id=NEW.id LOOP
   PERFORM fx_validate_line(line_id);
  END LOOP;
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER fx_entry_valid AFTER INSERT OR UPDATE ON journal_entry
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fx_entry_guard();
CREATE CONSTRAINT TRIGGER fx_line_valid AFTER INSERT OR UPDATE ON journal_line
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fx_line_guard();

CREATE FUNCTION fx_invoice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i invoice%ROWTYPE; bad boolean; policy_enabled boolean;
BEGIN
 IF TG_TABLE_NAME='invoice' THEN SELECT * INTO i FROM invoice WHERE id=COALESCE(NEW.id,OLD.id);
 ELSE SELECT * INTO i FROM invoice WHERE id=COALESCE(NEW.invoice_id,OLD.invoice_id); END IF;
 IF i.id IS NULL THEN RETURN NULL; END IF;
 IF i.fx_currency IS NULL THEN
  IF EXISTS(SELECT 1 FROM invoice_line WHERE invoice_id=i.id AND original_amount IS NOT NULL) THEN
   RAISE EXCEPTION 'FX_INVOICE_SHAPE: native amounts require a currency'; END IF;
  RETURN NULL;
 END IF;
 SELECT EXISTS(SELECT 1 FROM invoice_line il JOIN fx_currency c ON c.code=i.fx_currency
  WHERE il.invoice_id=i.id AND (il.original_amount IS NULL OR il.original_amount=0
   OR il.amount<>round(il.original_amount::numeric*(i.fx_snapshot->>'rate')::numeric*100/power(10::numeric,c.minor_digits)))) INTO bad;
 IF bad THEN RAISE EXCEPTION 'FX_INVOICE_CONVERSION: invoice base and native amounts disagree'; END IF;
 IF i.status='posted' THEN
  IF TG_TABLE_NAME='invoice' THEN
   IF TG_OP='UPDATE' AND OLD.status='draft' THEN
    SELECT c.enabled INTO policy_enabled FROM fx_company_currency c WHERE c.entity_id=i.entity_id AND c.currency=i.fx_currency FOR SHARE;
    IF NOT COALESCE(policy_enabled,false) THEN RAISE EXCEPTION 'FX_STOPPED: re-enable the currency before posting its draft'; END IF;
   END IF;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM journal_line WHERE entry_id=i.entry_id AND fx_invoice_id=i.id) THEN
   RAISE EXCEPTION 'FX_INVOICE_CONTROL: the foreign document must keep its tagged native control line';
  END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER fx_invoice_valid AFTER INSERT OR UPDATE ON invoice
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fx_invoice_guard();
CREATE CONSTRAINT TRIGGER fx_invoice_lines_valid AFTER INSERT OR UPDATE OR DELETE ON invoice_line
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fx_invoice_guard();

INSERT INTO audit_scope_source(table_name,scope_column,system_scope) VALUES
 ('fx_company_currency','entity_id',false),('fx_rate',NULL,true),('fx_currency',NULL,true);
COMMENT ON COLUMN journal_line.amount IS 'Functional currency minor units; FX native amounts are separate.';
COMMENT ON COLUMN journal_line.original_amount IS 'Signed native minor units; zero for monetary revaluation, NULL for legacy functional lines.';

-- Native settlement capacities; the legacy CAD branch is unchanged.
CREATE OR REPLACE FUNCTION check_application_valid() RETURNS trigger AS $$
DECLARE
  inv        record;
  src_doc    record;
  ent_status text;
  ent_ledger uuid;
  inv_mov    bigint;
  settle_net bigint;
  ent_applied bigint;
  consumed   bigint;
  src_mov    bigint;
  src_consumed bigint;
BEGIN
  SELECT i.id, i.status, i.ledger_id, i.party_id, i.control_account_id,
         i.entry_id, i.number, i.fx_currency
    INTO inv
    FROM invoice i WHERE i.id = NEW.invoice_id;

  IF inv.fx_currency IS NULL THEN
    IF NEW.original_amount IS NOT NULL OR NEW.carrying_amount IS NOT NULL OR EXISTS
      (SELECT 1 FROM journal_line WHERE entry_id=NEW.entry_id AND account_id=inv.control_account_id
       AND party_id=inv.party_id AND original_currency IS NOT NULL) THEN
      RAISE EXCEPTION 'FX_APPLICATION_CURRENCY: do not apply foreign money through the functional-only door';
    END IF;
  ELSE
    IF NEW.original_amount IS NULL OR NEW.carrying_amount IS NULL OR NEW.amount<>NEW.carrying_amount THEN
      RAISE EXCEPTION 'FX_APPLICATION_SHAPE: record native debt and functional carrying value separately';
    END IF;
    IF NEW.amount IS DISTINCT FROM
      (SELECT abs(sum(amount))::bigint FROM journal_line WHERE entry_id=NEW.entry_id AND fx_invoice_id=inv.id) THEN
      RAISE EXCEPTION 'FX_APPLICATION_CARRYING: the application must release the tagged control carrying amount';
    END IF;
  END IF;
  IF inv.status <> 'posted' THEN
    RAISE EXCEPTION 'APPLICATION_INVOICE_NOT_POSTED: % is %, and only a posted invoice is a debt',
      COALESCE(inv.number, 'that invoice'), inv.status;
  END IF;

  SELECT je.status, je.ledger_id INTO ent_status, ent_ledger
    FROM journal_entry je WHERE je.id = NEW.entry_id;

  IF ent_status <> 'posted' THEN
    RAISE EXCEPTION 'APPLICATION_ENTRY_NOT_POSTED: that entry is %, not posted', ent_status;
  END IF;

  IF ent_ledger IS DISTINCT FROM inv.ledger_id THEN
    RAISE EXCEPTION 'APPLICATION_LEDGER: that entry is in another set of books';
  END IF;

  -- The debt, read from the ledger.
  SELECT COALESCE(SUM(CASE WHEN inv.fx_currency IS NULL THEN jl.amount ELSE jl.original_amount END), 0) INTO inv_mov
    FROM journal_line jl
   WHERE jl.entry_id = inv.entry_id
     AND jl.account_id = inv.control_account_id
     AND jl.party_id = inv.party_id;

  IF inv_mov = 0 THEN
    RAISE EXCEPTION 'APPLICATION_NO_DEBT: the entry behind % holds nothing on its control account',
      COALESCE(inv.number, 'that invoice');
  END IF;

  -- The settling entry's NET movement for this account and party. Net, not the
  -- gross of one sign: an entry that puts +N and −N on the same party has
  -- moved nothing and settles nothing.
  SELECT COALESCE(SUM(CASE WHEN inv.fx_currency IS NULL THEN jl.amount ELSE jl.original_amount END), 0) INTO settle_net
    FROM journal_line jl
   WHERE jl.entry_id = NEW.entry_id
     AND jl.account_id = inv.control_account_id
     AND jl.party_id = inv.party_id
     AND (inv.fx_currency IS NULL OR (jl.original_currency=inv.fx_currency AND jl.fx_invoice_id=inv.id));

  IF settle_net = 0 OR sign(settle_net) <> -sign(inv_mov) THEN
    RAISE EXCEPTION 'APPLICATION_WRONG_WAY: that entry does not move %''s control account toward settling it',
      COALESCE(inv.number, 'that invoice');
  END IF;

  -- The entry cannot promise more than its net movement, across every invoice
  -- it settles for this account and party.
  SELECT COALESCE(SUM(CASE WHEN inv.fx_currency IS NULL THEN a.amount ELSE a.original_amount END), 0) INTO ent_applied
    FROM invoice_application a
    JOIN invoice i2 ON i2.id = a.invoice_id
   WHERE a.entry_id = NEW.entry_id
     AND i2.control_account_id = inv.control_account_id
     AND i2.party_id = inv.party_id
     AND (inv.fx_currency IS NULL OR a.invoice_id=inv.id);

  IF ent_applied > abs(settle_net) THEN
    RAISE EXCEPTION 'APPLICATION_OVER_ENTRY: that entry holds % toward this party and % is already applied',
      abs(settle_net), ent_applied;
  END IF;

  -- The TARGET document's whole consumption: applications on it, plus
  -- applications its own entry has made elsewhere. The same identity the
  -- balance derivation uses — one rule, not two spellings.
  SELECT COALESCE((SELECT SUM(CASE WHEN inv.fx_currency IS NULL THEN a.amount ELSE a.original_amount END) FROM invoice_application a
                    WHERE a.invoice_id = inv.id), 0)
       + COALESCE((SELECT SUM(CASE WHEN inv.fx_currency IS NULL THEN a.amount ELSE a.original_amount END) FROM invoice_application a
                    WHERE a.entry_id = inv.entry_id), 0)
    INTO consumed;

  IF consumed > abs(inv_mov) THEN
    RAISE EXCEPTION 'APPLICATION_OVER_INVOICE: % consumed of a % document, %',
      consumed, abs(inv_mov), COALESCE(inv.number, 'that invoice');
  END IF;

  -- And if the SETTLING entry is itself a document's entry (a credit note
  -- settling an invoice), that document's whole consumption too. This is the
  -- meeting point 0034 did not have: without it, a note could be paid down as
  -- a target and spent as a source, each side under its own cap, the two
  -- together at twice its value.
  SELECT i.id, i.number, i.entry_id, i.control_account_id, i.party_id
    INTO src_doc
    FROM invoice i WHERE i.entry_id = NEW.entry_id;

  IF src_doc.id IS NOT NULL THEN
    SELECT COALESCE(SUM(CASE WHEN inv.fx_currency IS NULL THEN jl.amount ELSE jl.original_amount END), 0) INTO src_mov
      FROM journal_line jl
     WHERE jl.entry_id = src_doc.entry_id
       AND jl.account_id = src_doc.control_account_id
       AND jl.party_id = src_doc.party_id;

    SELECT COALESCE((SELECT SUM(CASE WHEN inv.fx_currency IS NULL THEN a.amount ELSE a.original_amount END) FROM invoice_application a
                      WHERE a.invoice_id = src_doc.id), 0)
         + COALESCE((SELECT SUM(CASE WHEN inv.fx_currency IS NULL THEN a.amount ELSE a.original_amount END) FROM invoice_application a
                      WHERE a.entry_id = src_doc.entry_id), 0)
      INTO src_consumed;

    IF src_consumed > abs(src_mov) THEN
      RAISE EXCEPTION 'APPLICATION_OVER_DOCUMENT: that entry belongs to %, which would be consumed % of a % value',
        COALESCE(src_doc.number, 'a document'), src_consumed, abs(src_mov);
    END IF;
  END IF;

  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION forbid_application_edit() RETURNS trigger AS $$
BEGIN
 IF NEW.invoice_id IS DISTINCT FROM OLD.invoice_id OR NEW.amount IS DISTINCT FROM OLD.amount
  OR NEW.original_amount IS DISTINCT FROM OLD.original_amount OR NEW.carrying_amount IS DISTINCT FROM OLD.carrying_amount THEN
  RAISE EXCEPTION 'APPLICATION_IMMUTABLE: unapply it and apply again rather than editing it';
 END IF;
 RETURN NEW;
END $$ LANGUAGE plpgsql;

-- Ledger-native truth and application-native truth must agree at commit, including deletes.
CREATE FUNCTION fx_check_invoice(wanted uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE i invoice%ROWTYPE; issue_native bigint; issue_base bigint; control_native bigint; control_base bigint;
 n bigint; b bigint; consumed bigint;
BEGIN
 SELECT * INTO i FROM invoice WHERE id=wanted;
 IF i.id IS NULL OR i.fx_currency IS NULL OR i.status='draft' THEN RETURN; END IF;
 SELECT native_balance,carrying_balance INTO n,b FROM fx_invoice_at(i.id);
 IF i.status='void' THEN
  IF n<>0 OR b<>0 THEN RAISE EXCEPTION 'FX_VOID_POSITION: reverse related revaluations and settlements before voiding this foreign document'; END IF;
  RETURN;
 END IF;
 SELECT -sum(original_amount),-sum(amount) INTO issue_native,issue_base FROM invoice_line WHERE invoice_id=i.id;
 SELECT sum(original_amount),sum(amount) INTO control_native,control_base FROM journal_line WHERE entry_id=i.entry_id AND fx_invoice_id=i.id;
 IF control_native IS DISTINCT FROM issue_native OR control_base IS DISTINCT FROM issue_base THEN
  RAISE EXCEPTION 'FX_DOCUMENT_TRUTH: native and functional document lines must match their tagged control entry';
 END IF;
 IF n=0 AND b<>0 THEN RAISE EXCEPTION 'FX_SETTLEMENT_TRUTH: a fully settled foreign document cannot retain functional carrying value'; END IF;
 SELECT COALESCE(sum(original_amount),0)::bigint INTO consumed FROM invoice_application WHERE invoice_id=i.id;
 IF n IS DISTINCT FROM sign(issue_native)::bigint*(abs(issue_native)-consumed) OR consumed>abs(issue_native) THEN
  RAISE EXCEPTION 'FX_SETTLEMENT_TRUTH: native debt, settlement applications and ledger quantities disagree';
 END IF;
END $$;
CREATE FUNCTION fx_truth_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE wanted uuid;
BEGIN
 IF TG_TABLE_NAME='journal_line' THEN
  wanted:=CASE WHEN TG_OP='DELETE' THEN OLD.fx_invoice_id ELSE NEW.fx_invoice_id END;
 ELSE wanted:=CASE WHEN TG_OP='DELETE' THEN OLD.invoice_id ELSE NEW.invoice_id END;
 END IF;
 IF wanted IS NOT NULL THEN PERFORM fx_check_invoice(wanted); END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER fx_control_truth AFTER INSERT OR UPDATE OR DELETE ON journal_line
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fx_truth_trigger();
CREATE CONSTRAINT TRIGGER fx_application_truth AFTER INSERT OR UPDATE OR DELETE ON invoice_application
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fx_truth_trigger();
CREATE CONSTRAINT TRIGGER fx_document_line_truth AFTER INSERT OR UPDATE OR DELETE ON invoice_line
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fx_truth_trigger();

CREATE FUNCTION fx_original_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.original_currency IS NOT NULL AND EXISTS(SELECT 1 FROM journal_entry WHERE id=OLD.entry_id AND status<>'draft')
  AND (NEW.original_currency IS DISTINCT FROM OLD.original_currency OR NEW.original_amount IS DISTINCT FROM OLD.original_amount
   OR NEW.fx_snapshot IS DISTINCT FROM OLD.fx_snapshot OR NEW.fx_invoice_id IS DISTINCT FROM OLD.fx_invoice_id
   OR NEW.amount IS DISTINCT FROM OLD.amount) THEN
  RAISE EXCEPTION 'FX_ORIGINAL_IMMUTABLE: correct the foreign entry without rewriting its native amounts or rate';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER fx_original_frozen BEFORE UPDATE ON journal_line FOR EACH ROW EXECUTE FUNCTION fx_original_guard();

-- Reconciliation compares quantities in the bound bank currency.
CREATE OR REPLACE FUNCTION check_bank_match() RETURNS trigger AS $$
DECLARE
  b bank_transaction%ROWTYPE;
  entry_status text;
  entry_source text;
  on_account bigint;
BEGIN
  SELECT * INTO b FROM bank_transaction WHERE id = NEW.bank_transaction_id;

  IF b.ignored_at IS NOT NULL THEN
    RAISE EXCEPTION 'ROW_IGNORED: that row was ignored; un-ignore it before matching it';
  END IF;

  SELECT status, source_type INTO entry_status, entry_source
    FROM journal_entry WHERE id = NEW.entry_id;

  IF entry_status <> 'posted' THEN
    RAISE EXCEPTION 'ENTRY_NOT_POSTED: entry is %, and only a posted entry can settle a bank row',
      entry_status;
  END IF;

  IF entry_source = 'opening_balance' THEN
    RAISE EXCEPTION 'ENTRY_IS_OPENING: that is the opening balance — where the account started, not something that moved';
  END IF;

  -- The entry must actually have done something on this bank account, or the
  -- match is a sentence about two unrelated things.
  SELECT sum(COALESCE(jl.original_amount,jl.amount)) INTO on_account
    FROM journal_line jl
   WHERE jl.entry_id = NEW.entry_id AND jl.account_id = b.account_id;

  IF on_account IS NULL THEN
    RAISE EXCEPTION 'ENTRY_NOT_ON_ACCOUNT: that entry has no line on the account this statement is for';
  END IF;

  IF sign(NEW.amount) <> sign(b.amount) THEN
    RAISE EXCEPTION 'MATCH_SIGN: the bank row is % and the match is %; money cannot go both ways',
      CASE WHEN b.amount > 0 THEN 'money in' ELSE 'money out' END,
      CASE WHEN NEW.amount > 0 THEN 'money in' ELSE 'money out' END;
  END IF;

  IF sign(NEW.amount) <> sign(on_account) THEN
    RAISE EXCEPTION 'ENTRY_SIGN: that entry moved the account the other way';
  END IF;

  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- Reconciliation compares quantities in the bound bank currency.
CREATE OR REPLACE FUNCTION check_match_totals() RETURNS trigger AS $$
DECLARE
  row_id uuid;
  b bank_transaction%ROWTYPE;
  matched bigint;
  entry_total bigint;
  on_account bigint;
BEGIN
  row_id := coalesce(NEW.bank_transaction_id, OLD.bank_transaction_id);
  SELECT * INTO b FROM bank_transaction WHERE id = row_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT coalesce(sum(amount), 0) INTO matched FROM bank_match WHERE bank_transaction_id = row_id;
  IF abs(matched) > abs(b.amount) THEN
    RAISE EXCEPTION 'OVER_MATCHED: that row is % and % is already accounted for',
      b.amount, matched;
  END IF;

  IF NEW.entry_id IS NOT NULL THEN
    SELECT coalesce(sum(m.amount), 0) INTO entry_total
      FROM bank_match m JOIN bank_transaction bb ON bb.id = m.bank_transaction_id
     WHERE m.entry_id = NEW.entry_id AND bb.account_id = b.account_id;

    SELECT coalesce(sum(COALESCE(jl.original_amount,jl.amount)), 0) INTO on_account
      FROM journal_line jl
     WHERE jl.entry_id = NEW.entry_id AND jl.account_id = b.account_id;

    IF abs(entry_total) > abs(on_account) THEN
      RAISE EXCEPTION 'ENTRY_OVER_MATCHED: that entry moved % on this account and % is already claimed against it',
        on_account, entry_total;
    END IF;
  END IF;

  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE FUNCTION fx_currency_precision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.minor_digits<>OLD.minor_digits THEN RAISE EXCEPTION 'FX_PRECISION_LOCKED: currency units require a reviewed data migration'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER fx_currency_precision_frozen BEFORE UPDATE ON fx_currency FOR EACH ROW EXECUTE FUNCTION fx_currency_precision_guard();
CREATE INDEX audit_fx_noop_key ON audit_log(ledger_id,(context->>'fxKey')) WHERE action='fx_revalue_noop';
