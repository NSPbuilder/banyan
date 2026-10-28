-- The audit trail asks a register which column scopes an add-on's row.
--
-- audit_actor_from_setting (0086) named every table whose audit rows it gives a
-- company: SR&ED, payroll, the assistant and corporate records among them, so
-- the framework's own trigger knew the add-ons (docs/design/48-module-boundaries.md).
-- Base tables keep their lines below. An add-on table is a row here instead,
-- owned by that module: scope_column names the column its company is read
-- from, system_scope marks a table whose rows belong to the installation.
-- Every row resolves exactly as it did under 0086.
CREATE TABLE audit_scope_source (
  table_name   text PRIMARY KEY,
  scope_column text CHECK (scope_column IN ('ledger_id', 'entity_id')),
  system_scope boolean NOT NULL DEFAULT false,
  CHECK ((scope_column IS NULL) = system_scope)
);

INSERT INTO audit_scope_source (table_name, scope_column, system_scope) VALUES
  ('pay_run',                'ledger_id', false),
  ('payroll_employee',       'entity_id', false),
  ('payroll_rate_edition',   NULL,        true),
  ('ai_exchange',            'ledger_id', false),
  ('ai_bill_reading',        'ledger_id', false),
  ('ai_inquiry',             'ledger_id', false),
  ('user_ai_service',        NULL,        true),
  ('corporate_office',       'entity_id', false),
  ('directorship',           'entity_id', false),
  ('minute_book_entry',      'entity_id', false),
  ('share_class',            'entity_id', false),
  ('significant_individual', 'entity_id', false),
  ('sred_project',           'entity_id', false),
  ('sred_rate',              NULL,        true);

CREATE OR REPLACE FUNCTION audit_actor_from_setting() RETURNS trigger AS $$
DECLARE
  target uuid;
  entry_target uuid;
BEGIN
  IF NEW.actor = current_user::text THEN
    NEW.actor := coalesce(nullif(current_setting('app.actor', true), ''), NEW.actor);
  END IF;

  NEW.before := audit_redact(NEW.before);
  NEW.after := audit_redact(NEW.after);
  NEW.context := audit_redact(NEW.context);
  NEW.reason := COALESCE(NULLIF(btrim(NEW.reason), ''), NULLIF(btrim(NEW.context->>'reason'), ''));
  NEW.target_label := COALESCE(NULLIF(NEW.target_label, ''),
    NULLIF(NEW.context->>'entryNo', ''), NULLIF(NEW.context->>'name', ''),
    NULLIF(NEW.context->>'title', ''), NULLIF(NEW.context->>'email', ''),
    NULLIF(NEW.context->>'number', ''), NULLIF(NEW.context->>'statement_date', ''));

  NEW.ledger_id := COALESCE(NEW.ledger_id,
    audit_safe_uuid(NEW.context->>'ledger_id'), audit_safe_uuid(NEW.context->>'ledgerId'),
    audit_safe_uuid(NEW.before->>'ledger_id'), audit_safe_uuid(NEW.before->>'ledgerId'),
    audit_safe_uuid(NEW.after->>'ledger_id'), audit_safe_uuid(NEW.after->>'ledgerId'));
  NEW.entity_id := COALESCE(NEW.entity_id,
    audit_safe_uuid(NEW.context->>'entity_id'), audit_safe_uuid(NEW.context->>'entityId'),
    audit_safe_uuid(NEW.before->>'entity_id'), audit_safe_uuid(NEW.before->>'entityId'),
    audit_safe_uuid(NEW.after->>'entity_id'), audit_safe_uuid(NEW.after->>'entityId'));

  target := audit_safe_uuid(NEW.record_id);
  IF NEW.table_name = 'entity' THEN
    NEW.entity_id := COALESCE(NEW.entity_id, target);
  ELSIF NEW.table_name = 'ledger' THEN
    NEW.ledger_id := COALESCE(NEW.ledger_id, target);
  ELSIF NEW.ledger_id IS NULL AND target IS NOT NULL THEN
    IF NEW.table_name = 'journal_entry' THEN
      SELECT ledger_id INTO NEW.ledger_id FROM journal_entry WHERE id = target;
    ELSIF NEW.table_name = 'fiscal_period' THEN
      SELECT ledger_id INTO NEW.ledger_id FROM fiscal_period WHERE id = target;
    ELSIF NEW.table_name = 'fiscal_year' THEN
      SELECT ledger_id INTO NEW.ledger_id FROM fiscal_year WHERE id = target;
    ELSIF NEW.table_name = 'invoice' THEN
      SELECT ledger_id INTO NEW.ledger_id FROM invoice WHERE id = target;
    ELSIF EXISTS (SELECT 1 FROM audit_scope_source
                   WHERE table_name = NEW.table_name AND scope_column = 'ledger_id') THEN
      EXECUTE format('SELECT ledger_id FROM %I WHERE id = $1', NEW.table_name)
        INTO NEW.ledger_id USING target;
    END IF;
  END IF;

  entry_target := COALESCE(
    audit_safe_uuid(NEW.context->>'entry_id'), audit_safe_uuid(NEW.context->>'entryId'),
    audit_safe_uuid(NEW.before->>'entry_id'), audit_safe_uuid(NEW.after->>'entry_id'));
  IF NEW.ledger_id IS NULL AND entry_target IS NOT NULL THEN
    SELECT ledger_id INTO NEW.ledger_id FROM journal_entry WHERE id = entry_target;
  END IF;

  IF NEW.entity_id IS NULL AND NEW.ledger_id IS NOT NULL THEN
    SELECT entity_id INTO NEW.entity_id FROM ledger WHERE id = NEW.ledger_id;
  END IF;

  IF NEW.entity_id IS NULL AND target IS NOT NULL THEN
    IF NEW.table_name = 'account' THEN
      SELECT entity_id INTO NEW.entity_id FROM account WHERE id = target;
    ELSIF NEW.table_name = 'company_profile' THEN
      NEW.entity_id := COALESCE(NEW.entity_id, target);
    ELSIF NEW.table_name = 'entity_tax_registration' THEN
      SELECT entity_id INTO NEW.entity_id FROM entity_tax_registration WHERE id = target;
    ELSIF NEW.table_name = 'party_role' THEN
      SELECT entity_id INTO NEW.entity_id FROM party_role WHERE id = target;
    ELSIF NEW.table_name = 'bank_statement' THEN
      SELECT a.entity_id INTO NEW.entity_id
        FROM bank_statement s JOIN account a ON a.id = s.account_id WHERE s.id = target;
    ELSIF NEW.table_name = 'bank_transaction' THEN
      SELECT a.entity_id INTO NEW.entity_id
        FROM bank_transaction b JOIN account a ON a.id = b.account_id WHERE b.id = target;
    ELSIF NEW.table_name = 'bank_match' THEN
      SELECT a.entity_id INTO NEW.entity_id
        FROM bank_match m JOIN bank_transaction b ON b.id = m.bank_transaction_id
        JOIN account a ON a.id = b.account_id WHERE m.id = target;
    ELSIF EXISTS (SELECT 1 FROM audit_scope_source
                   WHERE table_name = NEW.table_name AND scope_column = 'entity_id') THEN
      EXECUTE format('SELECT entity_id FROM %I WHERE id = $1', NEW.table_name)
        INTO NEW.entity_id USING target;
    END IF;
  END IF;

  NEW.scope := CASE
    WHEN NEW.entity_id IS NOT NULL THEN 'company'
    WHEN NEW.scope IN ('shared', 'system') THEN NEW.scope
    WHEN NEW.table_name IN ('party', 'party_address', 'party_contact', 'party_role_definition')
      OR NEW.action = 'set_grants' THEN 'shared'
    WHEN NEW.table_name IN ('app_user', 'user_session', '_migration')
      OR EXISTS (SELECT 1 FROM audit_scope_source WHERE table_name = NEW.table_name AND system_scope)
      THEN 'system'
    ELSE 'unresolved'
  END;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
