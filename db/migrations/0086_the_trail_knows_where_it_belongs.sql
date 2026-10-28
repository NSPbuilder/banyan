-- 0086 — the trail knows where it belongs, and the application cannot erase it.
--
-- An audit row used to name only a table and an id. That was enough to find a
-- row while it existed and not enough after a deletion, nor enough to separate
-- one company's history from another's. Scope is now stored on the event itself:
-- company rows carry entity_id (and ledger_id where the relationship is real),
-- shared address-book/access changes say `shared`, system configuration says
-- `system`, and historical rows for which the evidence is insufficient stay
-- `unresolved`. Nothing guesses a company.
--
-- The same INSERT trigger strips authentication material defensively. The app
-- already omits password hashes, encrypted keys and session tokens; this keeps
-- a future caller from putting one into a JSON payload by mistake.
--
-- Finally, audit_log is append-only at the ordinary database door. A database
-- administrator can still bypass or replace database protections; this trigger
-- prevents accidental or application-level UPDATE, DELETE and TRUNCATE rather
-- than claiming absolute immutability.

ALTER TABLE audit_log
  ADD COLUMN entity_id uuid,
  ADD COLUMN ledger_id uuid,
  ADD COLUMN scope text NOT NULL DEFAULT 'unresolved'
    CHECK (scope IN ('company', 'shared', 'system', 'unresolved')),
  ADD COLUMN reason text,
  ADD COLUMN target_label text;

CREATE INDEX audit_log_entity_time_idx ON audit_log (entity_id, occurred_at DESC)
  WHERE entity_id IS NOT NULL;
CREATE INDEX audit_log_ledger_time_idx ON audit_log (ledger_id, occurred_at DESC)
  WHERE ledger_id IS NOT NULL;
CREATE INDEX audit_log_scope_time_idx ON audit_log (scope, occurred_at DESC);

CREATE OR REPLACE FUNCTION audit_safe_uuid(p_text text) RETURNS uuid AS $$
BEGIN
  IF p_text IS NULL OR p_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN NULL;
  END IF;
  RETURN p_text::uuid;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION audit_redact(p_value jsonb) RETURNS jsonb AS $$
DECLARE
  out_value jsonb;
BEGIN
  IF p_value IS NULL THEN RETURN NULL; END IF;
  IF jsonb_typeof(p_value) = 'object' THEN
    SELECT COALESCE(jsonb_object_agg(
      key,
      CASE
        WHEN lower(key) ~ '(^|_)(password|password_hash|token|token_hash|secret|api_key|key_enc|credential|authorization|cookie)($|_)'
          THEN '"[redacted]"'::jsonb
        ELSE audit_redact(value)
      END
    ), '{}'::jsonb)
      INTO out_value
      FROM jsonb_each(p_value);
    RETURN out_value;
  END IF;
  IF jsonb_typeof(p_value) = 'array' THEN
    SELECT COALESCE(jsonb_agg(audit_redact(value)), '[]'::jsonb)
      INTO out_value
      FROM jsonb_array_elements(p_value);
    RETURN out_value;
  END IF;
  RETURN p_value;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Existing rows: fill only what their own payload or a still-existing target
-- proves. Deleted rows with no surviving context remain unresolved on purpose.
UPDATE audit_log
   SET ledger_id = COALESCE(
         audit_safe_uuid(context->>'ledger_id'), audit_safe_uuid(context->>'ledgerId'),
         audit_safe_uuid(before->>'ledger_id'), audit_safe_uuid(before->>'ledgerId'),
         audit_safe_uuid(after->>'ledger_id'), audit_safe_uuid(after->>'ledgerId')),
       entity_id = COALESCE(
         audit_safe_uuid(context->>'entity_id'), audit_safe_uuid(context->>'entityId'),
         audit_safe_uuid(before->>'entity_id'), audit_safe_uuid(before->>'entityId'),
         audit_safe_uuid(after->>'entity_id'), audit_safe_uuid(after->>'entityId')),
       reason = NULLIF(btrim(context->>'reason'), ''),
       target_label = COALESCE(
         NULLIF(context->>'entryNo', ''), NULLIF(context->>'name', ''),
         NULLIF(context->>'title', ''), NULLIF(context->>'email', ''),
         NULLIF(context->>'number', ''), NULLIF(context->>'statement_date', ''));

UPDATE audit_log a
   SET ledger_id = audit_safe_uuid(a.record_id)
 WHERE a.table_name = 'ledger' AND a.ledger_id IS NULL
   AND audit_safe_uuid(a.record_id) IS NOT NULL;

UPDATE audit_log a
   SET ledger_id = je.ledger_id
  FROM journal_entry je
 WHERE a.table_name = 'journal_entry' AND audit_safe_uuid(a.record_id) = je.id
   AND a.ledger_id IS NULL;

UPDATE audit_log a
   SET ledger_id = x.ledger_id
  FROM (
    SELECT id, ledger_id FROM fiscal_period
    UNION ALL SELECT id, ledger_id FROM fiscal_year
    UNION ALL SELECT id, ledger_id FROM invoice
    UNION ALL SELECT id, ledger_id FROM pay_run
    UNION ALL SELECT id, ledger_id FROM ai_exchange
    UNION ALL SELECT id, ledger_id FROM ai_bill_reading
    UNION ALL SELECT id, ledger_id FROM ai_inquiry
  ) x
 WHERE audit_safe_uuid(a.record_id) = x.id
   AND a.table_name IN ('fiscal_period', 'fiscal_year', 'invoice', 'pay_run',
                        'ai_exchange', 'ai_bill_reading', 'ai_inquiry')
   AND a.ledger_id IS NULL;

UPDATE audit_log a
   SET entity_id = l.entity_id
  FROM ledger l
 WHERE a.ledger_id = l.id AND a.entity_id IS NULL;

UPDATE audit_log
   SET entity_id = audit_safe_uuid(record_id)
 WHERE table_name = 'entity' AND entity_id IS NULL
   AND audit_safe_uuid(record_id) IS NOT NULL;

UPDATE audit_log a
  SET entity_id = x.entity_id
  FROM (
    SELECT id, entity_id FROM account
    UNION ALL SELECT id, entity_id FROM corporate_office
    UNION ALL SELECT id, entity_id FROM dimension
    UNION ALL SELECT id, entity_id FROM directorship
    UNION ALL SELECT id, entity_id FROM entity_tax_registration
    UNION ALL SELECT id, entity_id FROM minute_book_entry
    UNION ALL SELECT id, entity_id FROM officer_position
    UNION ALL SELECT id, entity_id FROM party_role
    UNION ALL SELECT id, entity_id FROM payroll_employee
    UNION ALL SELECT id, entity_id FROM share_class
    UNION ALL SELECT id, entity_id FROM significant_individual
    UNION ALL SELECT id, entity_id FROM sred_project
  ) x
 WHERE audit_safe_uuid(a.record_id) = x.id AND a.entity_id IS NULL;

-- company_profile is keyed directly by entity_id rather than by an `id`
-- column. A matching record id is therefore direct evidence of ownership.
UPDATE audit_log
   SET entity_id = audit_safe_uuid(record_id)
 WHERE table_name = 'company_profile' AND entity_id IS NULL
   AND audit_safe_uuid(record_id) IS NOT NULL;

UPDATE audit_log
   SET scope = CASE
     WHEN entity_id IS NOT NULL THEN 'company'
     WHEN table_name IN ('party', 'party_address', 'party_contact', 'party_role_definition')
       OR action = 'set_grants' THEN 'shared'
     WHEN table_name IN ('app_user', 'user_session', 'user_ai_service',
                         'payroll_rate_edition', 'sred_rate', '_migration') THEN 'system'
     ELSE 'unresolved'
   END;

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
    ELSIF NEW.table_name = 'pay_run' THEN
      SELECT ledger_id INTO NEW.ledger_id FROM pay_run WHERE id = target;
    ELSIF NEW.table_name = 'ai_exchange' THEN
      SELECT ledger_id INTO NEW.ledger_id FROM ai_exchange WHERE id = target;
    ELSIF NEW.table_name = 'ai_bill_reading' THEN
      SELECT ledger_id INTO NEW.ledger_id FROM ai_bill_reading WHERE id = target;
    ELSIF NEW.table_name = 'ai_inquiry' THEN
      SELECT ledger_id INTO NEW.ledger_id FROM ai_inquiry WHERE id = target;
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
    ELSIF NEW.table_name = 'corporate_office' THEN
      SELECT entity_id INTO NEW.entity_id FROM corporate_office WHERE id = target;
    ELSIF NEW.table_name = 'directorship' THEN
      SELECT entity_id INTO NEW.entity_id FROM directorship WHERE id = target;
    ELSIF NEW.table_name = 'entity_tax_registration' THEN
      SELECT entity_id INTO NEW.entity_id FROM entity_tax_registration WHERE id = target;
    ELSIF NEW.table_name = 'minute_book_entry' THEN
      SELECT entity_id INTO NEW.entity_id FROM minute_book_entry WHERE id = target;
    ELSIF NEW.table_name = 'party_role' THEN
      SELECT entity_id INTO NEW.entity_id FROM party_role WHERE id = target;
    ELSIF NEW.table_name = 'payroll_employee' THEN
      SELECT entity_id INTO NEW.entity_id FROM payroll_employee WHERE id = target;
    ELSIF NEW.table_name = 'share_class' THEN
      SELECT entity_id INTO NEW.entity_id FROM share_class WHERE id = target;
    ELSIF NEW.table_name = 'significant_individual' THEN
      SELECT entity_id INTO NEW.entity_id FROM significant_individual WHERE id = target;
    ELSIF NEW.table_name = 'sred_project' THEN
      SELECT entity_id INTO NEW.entity_id FROM sred_project WHERE id = target;
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
    END IF;
  END IF;

  NEW.scope := CASE
    WHEN NEW.entity_id IS NOT NULL THEN 'company'
    WHEN NEW.scope IN ('shared', 'system') THEN NEW.scope
    WHEN NEW.table_name IN ('party', 'party_address', 'party_contact', 'party_role_definition')
      OR NEW.action = 'set_grants' THEN 'shared'
    WHEN NEW.table_name IN ('app_user', 'user_session', 'user_ai_service',
                            'payroll_rate_edition', 'sred_rate', '_migration') THEN 'system'
    ELSE 'unresolved'
  END;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION forbid_audit_log_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AUDIT_LOG_APPEND_ONLY: audit history cannot be changed or removed by the application';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_log_immutable
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_audit_log_change();

CREATE TRIGGER trg_audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_log_change();

COMMENT ON COLUMN audit_log.scope IS
  'company = one entity; shared = address-book/access change crossing companies; system = installation/user configuration; unresolved = historical evidence was insufficient.';
COMMENT ON COLUMN audit_log.entity_id IS
  'Stored without a foreign key so a deleted company remains attributable.';
COMMENT ON COLUMN audit_log.ledger_id IS
  'Stored without a foreign key so a deleted ledger remains attributable.';
COMMENT ON FUNCTION audit_redact(jsonb) IS
  'Defence in depth: removes authentication material from new audit JSON. Checksums detect change; they do not make an administrator unable to tamper.';
