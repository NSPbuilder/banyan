-- Payment stage wording is editable paper prose; the saved template stays frozen.
CREATE OR REPLACE FUNCTION invoice_template_snapshot_frozen() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'draft' AND (
    NEW.print_template_selection IS DISTINCT FROM OLD.print_template_selection
    OR NEW.print_template_snapshot IS DISTINCT FROM OLD.print_template_snapshot
  ) THEN
    IF current_setting('erp.project_write',true)='on'
      AND current_setting('erp.payment_stages_edit',true)='on'
      AND OLD.status='posted' AND OLD.direction='sales' AND OLD.document_kind='invoice'
      AND OLD.print_template_snapshot IS NOT NULL AND NEW.print_template_snapshot IS NOT NULL
      AND NEW.print_template_selection IS NOT DISTINCT FROM OLD.print_template_selection
      AND (NEW.print_template_snapshot-'paymentStages')=(OLD.print_template_snapshot-'paymentStages')
      AND (NOT (NEW.print_template_snapshot ? 'paymentStages') OR
        (jsonb_typeof(NEW.print_template_snapshot->'paymentStages')='string' AND length(NEW.print_template_snapshot->>'paymentStages')<=4000))
      AND (to_jsonb(NEW)-ARRAY['print_template_snapshot','version'])=(to_jsonb(OLD)-ARRAY['print_template_snapshot','version'])
      AND EXISTS(SELECT 1 FROM project_accounting_link WHERE invoice_id=OLD.id AND state='active')
    THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'TEMPLATE_SNAPSHOT_FROZEN: posted invoices keep their saved template';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
