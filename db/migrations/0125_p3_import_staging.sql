-- P3 source facts and resumable orchestration; every GL write still uses FigTree's existing posting door.
CREATE TABLE migration_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES entity(id),
  ledger_id uuid NOT NULL REFERENCES ledger(id),
  mode text NOT NULL CHECK(mode IN ('opening','history')),
  source_system text NOT NULL CHECK(length(source_system) BETWEEN 1 AND 100),
  source_company text NOT NULL CHECK(length(source_company) BETWEEN 1 AND 200),
  currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
  from_date date NOT NULL,
  cutoff_date date NOT NULL CHECK(cutoff_date >= from_date),
  clearing_account_id uuid NOT NULL REFERENCES account(id),
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','validated','running','failed','ready','active','cancelled','restored_paused')),
  version bigint NOT NULL DEFAULT 1 CHECK(version>0),
  validated_digest text CHECK(validated_digest IS NULL OR validated_digest ~ '^[a-f0-9]{64}$'),
  validation jsonb NOT NULL DEFAULT '{}',
  reconciliation jsonb,
  last_error text,
  actor_user_id uuid REFERENCES app_user(id) ON DELETE SET NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  activated_at timestamptz,
  UNIQUE(id,ledger_id,entity_id)
);
CREATE UNIQUE INDEX migration_one_target ON migration_run(ledger_id) WHERE status<>'cancelled';
CREATE INDEX migration_entity_state ON migration_run(entity_id,status);
CREATE TRIGGER p3_run_version BEFORE UPDATE ON migration_run FOR EACH ROW EXECUTE FUNCTION p1_bump_version();

CREATE TABLE migration_file (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES migration_run(id),
  kind text NOT NULL CHECK(kind IN ('accounts','trial_balance','open_items','starting_trial_balance','starting_open_items','general_ledger','applications')),
  sha256 text NOT NULL REFERENCES attachment_blob(sha256),
  filename text NOT NULL CHECK(length(filename) BETWEEN 1 AND 255),
  format jsonb NOT NULL CHECK(jsonb_typeof(format)='object'),
  headers jsonb NOT NULL CHECK(jsonb_typeof(headers)='array'),
  excluded_rows jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(excluded_rows)='array'),
  row_count integer NOT NULL CHECK(row_count BETWEEN 0 AND 10000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(run_id,kind)
);
CREATE TABLE migration_stage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id uuid NOT NULL REFERENCES migration_file(id) ON DELETE CASCADE,
  source_line integer NOT NULL CHECK(source_line>1),
  data jsonb NOT NULL CHECK(jsonb_typeof(data)='object' AND data->>'type' IN ('account','balance','item','gl','application')),
  UNIQUE(file_id,source_line)
);
CREATE TABLE migration_account_map (
  run_id uuid NOT NULL REFERENCES migration_run(id),
  source_account text NOT NULL CHECK(length(source_account) BETWEEN 1 AND 200),
  target_account_id uuid NOT NULL REFERENCES account(id),
  PRIMARY KEY(run_id,source_account)
);
CREATE TABLE migration_party_map (
  run_id uuid NOT NULL REFERENCES migration_run(id),
  source_party text NOT NULL CHECK(length(source_party) BETWEEN 1 AND 200),
  target_party_id uuid NOT NULL REFERENCES party(id),
  PRIMARY KEY(run_id,source_party)
);
CREATE TABLE migration_reference (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL,
  entity_id uuid NOT NULL,
  ledger_id uuid NOT NULL,
  source_system text NOT NULL,
  source_company text NOT NULL,
  source_key text NOT NULL CHECK(length(source_key) BETWEEN 1 AND 300),
  source_digest text NOT NULL CHECK(source_digest ~ '^[a-f0-9]{64}$'),
  source_rows jsonb NOT NULL CHECK(jsonb_typeof(source_rows)='array'),
  entry_id uuid REFERENCES journal_entry(id),
  invoice_id uuid REFERENCES invoice(id),
  application_id uuid REFERENCES invoice_application(id),
  original_issued_on date,
  original_due_on date,
  completed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(run_id,ledger_id,entity_id) REFERENCES migration_run(id,ledger_id,entity_id),
  CHECK(num_nonnulls(entry_id,invoice_id,application_id)>=1),
  UNIQUE(ledger_id,source_system,source_company,source_key)
);
CREATE INDEX migration_reference_run ON migration_reference(run_id);

CREATE FUNCTION p3_run_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM ledger WHERE id=NEW.ledger_id FOR UPDATE;
  IF TG_OP='INSERT' AND (EXISTS(SELECT 1 FROM journal_entry WHERE ledger_id=NEW.ledger_id)
    OR EXISTS(SELECT 1 FROM invoice WHERE ledger_id=NEW.ledger_id)
    OR EXISTS(SELECT 1 FROM bank_transaction b JOIN account a ON a.id=b.account_id WHERE a.entity_id=NEW.entity_id)
    OR EXISTS(SELECT 1 FROM bank_statement b JOIN account a ON a.id=b.account_id WHERE a.entity_id=NEW.entity_id))
    THEN RAISE EXCEPTION 'P3_TARGET_NOT_EMPTY'; END IF;
  IF NOT EXISTS(SELECT 1 FROM ledger l JOIN account a ON a.id=NEW.clearing_account_id
    WHERE l.id=NEW.ledger_id AND l.entity_id=NEW.entity_id AND a.entity_id=NEW.entity_id
      AND a.account_type='equity' AND a.is_active AND a.is_postable AND l.currency=NEW.currency)
    THEN RAISE EXCEPTION 'P3_RUN_SCOPE: target ledger/currency/clearing account does not match'; END IF;
  IF TG_OP='UPDATE' AND (NEW.ledger_id IS DISTINCT FROM OLD.ledger_id OR NEW.entity_id IS DISTINCT FROM OLD.entity_id
    OR NEW.mode IS DISTINCT FROM OLD.mode OR NEW.source_system IS DISTINCT FROM OLD.source_system
    OR NEW.source_company IS DISTINCT FROM OLD.source_company OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.from_date IS DISTINCT FROM OLD.from_date OR NEW.cutoff_date IS DISTINCT FROM OLD.cutoff_date
    OR NEW.clearing_account_id IS DISTINCT FROM OLD.clearing_account_id) THEN RAISE EXCEPTION 'P3_RUN_IDENTITY'; END IF;
  IF TG_OP='UPDATE' AND NEW.status='cancelled' AND EXISTS(SELECT 1 FROM migration_reference WHERE run_id=OLD.id)
    THEN RAISE EXCEPTION 'P3_COMMITTED_IMPORT_KEPT: a committed migration cannot be cancelled to reopen ordinary writes'; END IF;
  IF TG_OP='UPDATE' AND OLD.status='active' AND NEW.status<>'active' THEN RAISE EXCEPTION 'P3_ACTIVE_RUN_KEPT'; END IF;
  IF TG_OP='UPDATE' AND NEW.status<>OLD.status AND NOT (
    OLD.status='draft' AND NEW.status IN ('validated','cancelled')
    OR OLD.status='validated' AND NEW.status IN ('draft','running','cancelled')
    OR OLD.status IN ('running','failed','restored_paused') AND NEW.status IN ('running','failed','ready')
    OR OLD.status='ready' AND NEW.status IN ('active','failed')) THEN RAISE EXCEPTION 'P3_RUN_TRANSITION'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER p3_run_scope BEFORE INSERT OR UPDATE ON migration_run FOR EACH ROW EXECUTE FUNCTION p3_run_scope();

CREATE FUNCTION p3_stage_owner() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; state text; company uuid;
BEGIN
  IF TG_OP='UPDATE' AND (to_jsonb(NEW)->>'run_id' IS DISTINCT FROM to_jsonb(OLD)->>'run_id'
    OR to_jsonb(NEW)->>'file_id' IS DISTINCT FROM to_jsonb(OLD)->>'file_id') THEN RAISE EXCEPTION 'P3_SOURCE_OWNER_KEPT'; END IF;
  IF TG_TABLE_NAME='migration_stage' THEN SELECT f.run_id INTO target FROM migration_file f WHERE f.id=COALESCE(NEW.file_id,OLD.file_id);
  ELSE target=COALESCE(NEW.run_id,OLD.run_id); END IF;
  SELECT status,entity_id INTO state,company FROM migration_run WHERE id=target FOR UPDATE;
  IF state IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'P3_STAGING_FROZEN'; END IF;
  IF TG_OP<>'DELETE' AND TG_TABLE_NAME='migration_account_map' AND NOT EXISTS(SELECT 1 FROM account WHERE id=NEW.target_account_id AND entity_id=company AND is_active AND is_postable)
    THEN RAISE EXCEPTION 'P3_ACCOUNT_MAP_SCOPE'; END IF;
  IF TG_OP<>'DELETE' AND TG_TABLE_NAME='migration_party_map' AND NOT EXISTS(SELECT 1 FROM party_role WHERE party_id=NEW.target_party_id AND entity_id=company AND role IN ('customer','supplier'))
    THEN RAISE EXCEPTION 'P3_PARTY_MAP_SCOPE'; END IF;
  RETURN COALESCE(NEW,OLD);
END $$;
CREATE TRIGGER p3_file_owner BEFORE INSERT OR UPDATE OR DELETE ON migration_file FOR EACH ROW EXECUTE FUNCTION p3_stage_owner();
CREATE TRIGGER p3_stage_owner BEFORE INSERT OR UPDATE OR DELETE ON migration_stage FOR EACH ROW EXECUTE FUNCTION p3_stage_owner();
CREATE TRIGGER p3_account_map_owner BEFORE INSERT OR UPDATE OR DELETE ON migration_account_map FOR EACH ROW EXECUTE FUNCTION p3_stage_owner();
CREATE TRIGGER p3_party_map_owner BEFORE INSERT OR UPDATE OR DELETE ON migration_party_map FOR EACH ROW EXECUTE FUNCTION p3_stage_owner();

CREATE FUNCTION p3_reference_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE run migration_run%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'P3_SOURCE_REFERENCE_KEPT'; END IF;
  SELECT * INTO run FROM migration_run WHERE id=NEW.run_id;
  IF run.status IS DISTINCT FROM 'running' OR COALESCE(current_setting('erp.migration_run',true),'')<>run.id::text
    THEN RAISE EXCEPTION 'P3_SOURCE_REFERENCE_OWNER'; END IF;
  IF NEW.source_system<>run.source_system OR NEW.source_company<>run.source_company
    OR NEW.entry_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM journal_entry WHERE id=NEW.entry_id AND ledger_id=run.ledger_id)
    OR NEW.invoice_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM invoice WHERE id=NEW.invoice_id AND ledger_id=run.ledger_id)
    OR NEW.application_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM invoice_application a JOIN invoice i ON i.id=a.invoice_id WHERE a.id=NEW.application_id AND i.ledger_id=run.ledger_id)
    THEN RAISE EXCEPTION 'P3_SOURCE_REFERENCE_SCOPE'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER p3_reference_scope BEFORE INSERT OR UPDATE OR DELETE ON migration_reference FOR EACH ROW EXECUTE FUNCTION p3_reference_scope();

CREATE FUNCTION p3_migration_write_gate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; row_data jsonb; run migration_run%ROWTYPE; authorized text;
BEGIN
  row_data=to_jsonb(COALESCE(NEW,OLD));
  IF TG_TABLE_NAME='journal_line' THEN SELECT ledger_id INTO target FROM journal_entry WHERE id=(row_data->>'entry_id')::uuid;
  ELSIF TG_TABLE_NAME='invoice_line' OR TG_TABLE_NAME='invoice_application' THEN SELECT ledger_id INTO target FROM invoice WHERE id=(row_data->>'invoice_id')::uuid;
  ELSIF TG_TABLE_NAME IN ('bank_transaction','bank_statement') THEN SELECT l.id INTO target FROM account a JOIN ledger l ON l.entity_id=a.entity_id WHERE a.id=(row_data->>'account_id')::uuid;
  ELSE target=(row_data->>'ledger_id')::uuid; END IF;
  IF target IS NULL THEN RETURN COALESCE(NEW,OLD); END IF;
  -- Serialize run creation with every financial writer before testing emptiness.
  PERFORM 1 FROM ledger WHERE id=target FOR SHARE;
  SELECT * INTO run FROM migration_run WHERE ledger_id=target AND status<>'cancelled';
  IF NOT FOUND THEN RETURN COALESCE(NEW,OLD); END IF;
  authorized=current_setting('erp.migration_run',true);
  IF run.status<>'active' AND NOT (COALESCE(authorized,'')=run.id::text AND run.status='running')
    THEN RAISE EXCEPTION 'P3_MIGRATION_INCOMPLETE: ordinary financial writes are paused until reconciliation and activation'; END IF;
  IF run.status='active' AND TG_TABLE_NAME='journal_entry' AND TG_OP<>'DELETE'
    AND (row_data->>'entry_date')::date < (CASE WHEN run.mode='opening' THEN run.cutoff_date ELSE run.from_date-1 END)
    THEN RAISE EXCEPTION 'P3_BEFORE_IMPORTED_COVERAGE'; END IF;
  RETURN COALESCE(NEW,OLD);
END $$;
DO $$ DECLARE t text; BEGIN
  FOR t IN SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='ledger_id'
    AND table_name NOT IN ('audit_log','period_balance','migration_run','migration_reference','document_edit_lease','ai_bill_reading','inbox_item','recurring_template','recurring_occurrence','reminder_rule','email_message','background_job')
    AND table_name IN (SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE')
  UNION SELECT unnest(ARRAY['journal_line','invoice_line','invoice_application','bank_transaction','bank_statement']) LOOP
    EXECUTE format('CREATE TRIGGER p3_migration_write_gate BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION p3_migration_write_gate()',t);
  END LOOP;
END $$;
