-- Explicit ownership: Project is the editor; Invoices and Expenses are views
-- of the same business transaction. Legacy manual handoffs stay snapshots.
CREATE TABLE project_accounting_link (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL,
  project_id uuid NOT NULL,
  record_id uuid NOT NULL UNIQUE,
  ledger_id uuid NOT NULL REFERENCES ledger(id),
  invoice_id uuid UNIQUE REFERENCES invoice(id) ON DELETE SET NULL,
  expense_entry_id uuid UNIQUE REFERENCES journal_entry(id) ON DELETE SET NULL,
  control_account_id uuid REFERENCES account(id),
  gst_account_id uuid REFERENCES account(id),
  pst_account_id uuid REFERENCES account(id),
  bank_account_id uuid REFERENCES account(id),
  mapping_hash text NOT NULL,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','void')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (record_id,entity_id,project_id) REFERENCES project_record(id,entity_id,project_id),
  CHECK (state='void' OR (invoice_id IS NOT NULL) <> (expense_entry_id IS NOT NULL))
);
CREATE INDEX project_accounting_project ON project_accounting_link(entity_id,project_id);
CREATE TABLE project_accounting_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES entity(id),
  link_id uuid NOT NULL REFERENCES project_accounting_link(id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position>0),
  account_id uuid NOT NULL REFERENCES account(id),
  UNIQUE(link_id,position)
);
CREATE TABLE project_accounting_payment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL,
  project_id uuid NOT NULL,
  payment_id uuid NOT NULL UNIQUE,
  entry_id uuid REFERENCES journal_entry(id) ON DELETE SET NULL,
  origin text NOT NULL CHECK (origin IN ('project','accounting')),
  mapping_hash text,
  FOREIGN KEY (payment_id,entity_id,project_id) REFERENCES project_payment(id,entity_id,project_id),
  UNIQUE(entry_id,project_id)
);
CREATE TABLE project_accounting_application (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES entity(id),
  allocation_id uuid NOT NULL UNIQUE REFERENCES project_payment_allocation(id),
  application_id uuid UNIQUE REFERENCES invoice_application(id) ON DELETE SET NULL
);

CREATE FUNCTION check_project_accounting_scope() RETURNS trigger AS $$
DECLARE e uuid; p uuid; rkind text; rparty uuid;
BEGIN
  IF TG_TABLE_NAME='project_accounting_link' THEN
    SELECT entity_id,project_id,kind,party_id INTO e,p,rkind,rparty FROM project_record WHERE id=NEW.record_id;
    IF e IS DISTINCT FROM NEW.entity_id OR p IS DISTINCT FROM NEW.project_id
      OR NOT EXISTS(SELECT 1 FROM ledger WHERE id=NEW.ledger_id AND entity_id=e)
      OR EXISTS(SELECT 1 FROM account WHERE id IN (NEW.control_account_id,NEW.gst_account_id,NEW.pst_account_id,NEW.bank_account_id) AND entity_id<>e)
      OR (NEW.invoice_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM invoice WHERE id=NEW.invoice_id AND entity_id=e AND ledger_id=NEW.ledger_id AND party_id=rparty AND direction=CASE WHEN rkind='revenue' THEN 'sales' ELSE 'purchase' END AND document_kind='invoice'))
      OR (NEW.expense_entry_id IS NOT NULL AND (rkind<>'cost' OR NOT EXISTS(SELECT 1 FROM journal_entry WHERE id=NEW.expense_entry_id AND ledger_id=NEW.ledger_id AND source_type='quick_expense')))
    THEN RAISE EXCEPTION 'PROJECT_ACCOUNTING_SCOPE: Accounting record must belong to the same project and company'; END IF;
  ELSIF TG_TABLE_NAME='project_accounting_line' THEN
    IF NOT EXISTS(SELECT 1 FROM project_accounting_link h JOIN account a ON a.id=NEW.account_id WHERE h.id=NEW.link_id AND h.entity_id=NEW.entity_id AND a.entity_id=h.entity_id)
    THEN RAISE EXCEPTION 'PROJECT_ACCOUNTING_SCOPE: Line account must belong to the linked company'; END IF;
  ELSIF TG_TABLE_NAME='project_accounting_payment' THEN
    IF NOT EXISTS(SELECT 1 FROM project_payment p WHERE p.id=NEW.payment_id AND p.entity_id=NEW.entity_id AND p.project_id=NEW.project_id)
      OR (NEW.entry_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM journal_entry j JOIN ledger l ON l.id=j.ledger_id WHERE j.id=NEW.entry_id AND l.entity_id=NEW.entity_id AND j.source_type IN ('payment','quick_expense')))
    THEN RAISE EXCEPTION 'PROJECT_ACCOUNTING_SCOPE: Payment must belong to the same company'; END IF;
  ELSE
    IF NOT EXISTS(SELECT 1 FROM project_payment_allocation a JOIN project_accounting_link h ON h.record_id=a.record_id
      JOIN invoice_application ia ON ia.id=NEW.application_id JOIN project_accounting_payment pp ON pp.payment_id=a.payment_id
      WHERE a.id=NEW.allocation_id AND a.entity_id=NEW.entity_id AND ia.invoice_id=h.invoice_id AND ia.entry_id=pp.entry_id AND ia.amount=a.amount_cents)
      AND NEW.application_id IS NOT NULL
    THEN RAISE EXCEPTION 'PROJECT_ACCOUNTING_SCOPE: Application must match its project allocation'; END IF;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER project_accounting_link_scope BEFORE INSERT OR UPDATE ON project_accounting_link FOR EACH ROW EXECUTE FUNCTION check_project_accounting_scope();
CREATE TRIGGER project_accounting_line_scope BEFORE INSERT OR UPDATE ON project_accounting_line FOR EACH ROW EXECUTE FUNCTION check_project_accounting_scope();
CREATE TRIGGER project_accounting_payment_scope BEFORE INSERT OR UPDATE ON project_accounting_payment FOR EACH ROW EXECUTE FUNCTION check_project_accounting_scope();
CREATE TRIGGER project_accounting_application_scope BEFORE INSERT OR UPDATE ON project_accounting_application FOR EACH ROW EXECUTE FUNCTION check_project_accounting_scope();

-- Reject alternate editors, including AI and generic journal doors. Posting a
-- draft remains available in Invoices; it changes no source amounts or dates.
CREATE FUNCTION project_accounting_owner_guard() RETURNS trigger AS $$
DECLARE target uuid; owned boolean;
BEGIN
  IF current_setting('erp.project_write',true)='on' THEN RETURN COALESCE(NEW,OLD); END IF;
  IF TG_TABLE_NAME='invoice' THEN
    target=OLD.id;
    IF TG_OP='UPDATE' AND OLD.status='draft' AND NEW.status='posted'
      AND (to_jsonb(NEW)-ARRAY['status','entry_id','posted_at','posted_by','print_template_snapshot'])=(to_jsonb(OLD)-ARRAY['status','entry_id','posted_at','posted_by','print_template_snapshot'])
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
CREATE TRIGGER project_owned_invoice BEFORE UPDATE OR DELETE ON invoice FOR EACH ROW EXECUTE FUNCTION project_accounting_owner_guard();
CREATE TRIGGER project_owned_invoice_line BEFORE INSERT OR UPDATE OR DELETE ON invoice_line FOR EACH ROW EXECUTE FUNCTION project_accounting_owner_guard();
CREATE TRIGGER project_owned_entry BEFORE UPDATE OR DELETE ON journal_entry FOR EACH ROW EXECUTE FUNCTION project_accounting_owner_guard();
CREATE TRIGGER project_owned_entry_line BEFORE INSERT OR UPDATE OR DELETE ON journal_line FOR EACH ROW EXECUTE FUNCTION project_accounting_owner_guard();
CREATE TRIGGER project_owned_record BEFORE UPDATE OR DELETE ON project_record FOR EACH ROW EXECUTE FUNCTION project_accounting_owner_guard();
CREATE TRIGGER project_owned_record_line BEFORE INSERT OR UPDATE OR DELETE ON project_record_line FOR EACH ROW EXECUTE FUNCTION project_accounting_owner_guard();
CREATE TRIGGER project_owned_payment BEFORE UPDATE OR DELETE ON project_payment FOR EACH ROW EXECUTE FUNCTION project_accounting_owner_guard();
CREATE TRIGGER project_owned_allocation BEFORE INSERT OR UPDATE OR DELETE ON project_payment_allocation FOR EACH ROW EXECUTE FUNCTION project_accounting_owner_guard();

-- Payments made in either workspace settle ONE document. Mirroring the
-- application at the database boundary also covers credit/undo/bulk doors.
CREATE FUNCTION mirror_project_invoice_application() RETURNS trigger AS $$
DECLARE h project_accounting_link; pp project_accounting_payment; pay uuid; alloc uuid;
  j journal_entry; r project_record; prior text; remaining bigint;
BEGIN
  prior=current_setting('erp.project_write',true);
  IF TG_OP='INSERT' THEN
    SELECT * INTO h FROM project_accounting_link WHERE invoice_id=NEW.invoice_id AND state='active';
    IF h.id IS NULL THEN RETURN NEW; END IF;
    SELECT * INTO j FROM journal_entry WHERE id=NEW.entry_id;
    IF j.source_type<>'payment' THEN RAISE EXCEPTION 'PROJECT_PAYMENT_SOURCE: Use a Payment to settle a Project document'; END IF;
    SELECT * INTO r FROM project_record WHERE id=h.record_id;
    PERFORM 1 FROM project WHERE id=h.project_id FOR UPDATE;
    PERFORM set_config('erp.project_write','on',true);
    SELECT * INTO pp FROM project_accounting_payment WHERE entry_id=j.id AND project_id=h.project_id;
    IF pp.id IS NULL THEN
      INSERT INTO project_payment(entity_id,project_id,party_id,direction,payment_date,amount_cents,reference,created_by)
        VALUES(h.entity_id,h.project_id,r.party_id,CASE WHEN r.kind='revenue' THEN 'received' ELSE 'paid' END,j.entry_date,NEW.amount,j.document_ref,NEW.applied_by)
        RETURNING id INTO pay;
      INSERT INTO project_accounting_payment(entity_id,project_id,payment_id,entry_id,origin)
        VALUES(h.entity_id,h.project_id,pay,j.id,'accounting');
    ELSE
      pay=pp.payment_id;
      IF pp.origin='accounting' THEN
        SELECT coalesce(sum(amount_cents),0) INTO remaining FROM project_payment_allocation WHERE payment_id=pay AND state='active';
        UPDATE project_payment SET amount_cents=remaining+NEW.amount,state='active',version=version+1 WHERE id=pay;
      END IF;
    END IF;
    INSERT INTO project_payment_allocation(entity_id,project_id,party_id,payment_id,record_id,effective_date,amount_cents,created_by)
      VALUES(h.entity_id,h.project_id,r.party_id,pay,r.id,greatest(j.entry_date,r.record_date),NEW.amount,NEW.applied_by) RETURNING id INTO alloc;
    INSERT INTO project_accounting_application(entity_id,allocation_id,application_id) VALUES(h.entity_id,alloc,NEW.id);
    INSERT INTO audit_log(actor,action,table_name,record_id,entity_id,ledger_id,scope,after)
      VALUES(NEW.applied_by,'sync_project_payment','project_payment',pay::text,h.entity_id,h.ledger_id,'company',jsonb_build_object('entryId',j.id,'invoiceId',h.invoice_id,'amount',NEW.amount::text));
    PERFORM set_config('erp.project_write',coalesce(prior,''),true);
    RETURN NEW;
  ELSE
    SELECT a.id,a.payment_id INTO alloc,pay FROM project_accounting_application b
      JOIN project_payment_allocation a ON a.id=b.allocation_id WHERE b.application_id=OLD.id;
    IF alloc IS NULL THEN RETURN OLD; END IF;
    SELECT * INTO pp FROM project_accounting_payment WHERE payment_id=pay;
    PERFORM 1 FROM project WHERE id=pp.project_id FOR UPDATE;
    PERFORM set_config('erp.project_write','on',true);
    UPDATE project_payment_allocation SET state='void',version=version+1 WHERE id=alloc AND state='active';
    IF pp.origin='accounting' THEN
      SELECT coalesce(sum(amount_cents),0) INTO remaining FROM project_payment_allocation WHERE payment_id=pay AND state='active';
      IF remaining=0 THEN UPDATE project_payment SET state='void',version=version+1 WHERE id=pay AND state='active';
      ELSE UPDATE project_payment SET amount_cents=remaining,version=version+1 WHERE id=pay; END IF;
    END IF;
    INSERT INTO audit_log(actor,action,table_name,record_id,entity_id,scope,after)
      VALUES(coalesce(nullif(current_setting('app.actor',true),''),current_user),'sync_project_unapply','project_payment_allocation',alloc::text,pp.entity_id,'company',jsonb_build_object('state','void'));
    PERFORM set_config('erp.project_write',coalesce(prior,''),true);
    RETURN OLD;
  END IF;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER project_application_added AFTER INSERT ON invoice_application FOR EACH ROW EXECUTE FUNCTION mirror_project_invoice_application();
CREATE TRIGGER project_application_removed BEFORE DELETE ON invoice_application FOR EACH ROW EXECUTE FUNCTION mirror_project_invoice_application();
CREATE FUNCTION project_application_update_guard() RETURNS trigger AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM project_accounting_application WHERE application_id=OLD.id)
    OR EXISTS(SELECT 1 FROM project_accounting_link WHERE invoice_id IN (OLD.invoice_id,NEW.invoice_id) AND state='active')
  THEN RAISE EXCEPTION 'PROJECT_APPLICATION_EDIT: Unapply and apply the payment again to change its allocation'; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER project_application_updated BEFORE UPDATE ON invoice_application FOR EACH ROW EXECUTE FUNCTION project_application_update_guard();
