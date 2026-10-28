-- Version metadata participates in existing deferred checks and Project ownership.
-- Preserve every business ownership / scope / live-entry check from FigTree.
CREATE OR REPLACE FUNCTION check_invoice_entry() RETURNS trigger AS $$
DECLARE
  current_invoice invoice%ROWTYPE;
  e_source    text;
  e_source_id uuid;
  e_ledger    uuid;
  e_status    text;
  want        text;
BEGIN
  SELECT * INTO current_invoice FROM invoice WHERE id=NEW.id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  NEW := current_invoice;
  IF NEW.entry_id IS NULL THEN RETURN NULL; END IF;

  SELECT source_type, source_id, ledger_id, status
    INTO e_source, e_source_id, e_ledger, e_status
    FROM journal_entry WHERE id = NEW.entry_id;

  want := CASE WHEN NEW.direction = 'sales' THEN 'ar_invoice' ELSE 'ap_bill' END;

  IF e_source IS DISTINCT FROM want OR e_source_id IS DISTINCT FROM NEW.id THEN
    RAISE EXCEPTION 'INVOICE_ENTRY_MISMATCH: that entry is % %, not the entry this invoice produced',
      COALESCE(e_source, 'missing'), COALESCE(e_source_id::text, '');
  END IF;

  IF e_ledger IS DISTINCT FROM NEW.ledger_id THEN
    RAISE EXCEPTION 'INVOICE_ENTRY_LEDGER: that entry is in another set of books';
  END IF;

  IF e_status IS DISTINCT FROM 'posted' THEN
    RAISE EXCEPTION 'INVOICE_ENTRY_NOT_LIVE: that entry is %, so this invoice would say posted while the ledger says otherwise',
      COALESCE(e_status, 'missing');
  END IF;

  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION project_accounting_owner_guard() RETURNS trigger AS $$
DECLARE target uuid; owned boolean;
BEGIN
  IF TG_OP='UPDATE' AND TG_TABLE_NAME IN ('invoice','journal_entry')
    AND (to_jsonb(NEW)-'version')=(to_jsonb(OLD)-'version') THEN RETURN NEW; END IF;
  IF current_setting('erp.project_write',true)='on' THEN RETURN COALESCE(NEW,OLD); END IF;
  IF TG_TABLE_NAME='invoice' THEN
    target=OLD.id;
    IF TG_OP='UPDATE' AND OLD.status='draft' AND NEW.status='posted'
      AND (to_jsonb(NEW)-ARRAY['status','entry_id','posted_at','posted_by','print_template_snapshot','version'])=(to_jsonb(OLD)-ARRAY['status','entry_id','posted_at','posted_by','print_template_snapshot','version'])
    THEN RETURN NEW; END IF;
    SELECT EXISTS(SELECT 1 FROM project_accounting_link WHERE invoice_id=target AND state='active') INTO owned;
  ELSIF TG_TABLE_NAME='invoice_line' THEN
    target=COALESCE(NEW.invoice_id,OLD.invoice_id);
    SELECT EXISTS(SELECT 1 FROM project_accounting_link WHERE invoice_id=target AND state='active') INTO owned;
  ELSIF TG_TABLE_NAME IN ('journal_entry','journal_line') THEN
    IF TG_TABLE_NAME='journal_entry' THEN target=OLD.id; ELSE target=COALESCE(NEW.entry_id,OLD.entry_id); END IF;
    SELECT EXISTS(SELECT 1 FROM project_accounting_link WHERE expense_entry_id=target AND state='active')
      OR EXISTS(SELECT 1 FROM project_accounting_payment WHERE entry_id=target)
      OR EXISTS(SELECT 1 FROM project_accounting_link h JOIN invoice i ON i.id=h.invoice_id WHERE i.entry_id=target AND h.state='active') INTO owned;
  ELSIF TG_TABLE_NAME IN ('project_record','project_record_line') THEN
    IF TG_TABLE_NAME='project_record' THEN target=OLD.id; ELSE target=COALESCE(NEW.record_id,OLD.record_id); END IF;
    SELECT EXISTS(SELECT 1 FROM project_accounting_link WHERE record_id=target AND state='active') INTO owned;
  ELSE
    IF TG_TABLE_NAME='project_payment' THEN target=OLD.id;
    ELSE target=COALESCE(NEW.payment_id,OLD.payment_id); END IF;
    SELECT EXISTS(SELECT 1 FROM project_accounting_payment WHERE payment_id=target) INTO owned;
  END IF;
  IF owned THEN RAISE EXCEPTION 'PROJECT_ACCOUNTING_OWNER: Edit or cancel this transaction from its Project'; END IF;
  RETURN COALESCE(NEW,OLD);
END; $$ LANGUAGE plpgsql;
