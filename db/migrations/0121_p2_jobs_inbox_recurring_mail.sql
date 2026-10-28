-- P2 business facts are company-owned. Credentials stay in installation config.
CREATE TABLE automation_setting (
  entity_id uuid PRIMARY KEY REFERENCES entity(id),
  enabled boolean NOT NULL DEFAULT false,
  mail_enabled boolean NOT NULL DEFAULT false,
  timezone text NOT NULL DEFAULT 'America/Vancouver',
  sender_email text,
  max_concurrency integer NOT NULL DEFAULT 2 CHECK (max_concurrency BETWEEN 1 AND 5),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE TABLE recurring_template (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES entity(id), ledger_id uuid NOT NULL REFERENCES ledger(id),
  actor_user_id uuid REFERENCES app_user(id) ON DELETE SET NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  document_type text NOT NULL CHECK (document_type IN ('sales','purchase','entry')),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot)='object'),
  frequency text NOT NULL CHECK (frequency IN ('weekly','monthly','quarterly','yearly')),
  day_mode text NOT NULL CHECK (day_mode IN ('fixed','month_end','last_weekday')),
  anchor_date date NOT NULL, next_date date NOT NULL, end_date date,
  max_occurrences integer CHECK (max_occurrences BETWEEN 1 AND 100000),
  occurrence_count integer NOT NULL DEFAULT 0 CHECK (occurrence_count>=0),
  due_days integer NOT NULL DEFAULT 30 CHECK (due_days BETWEEN 0 AND 366),
  active boolean NOT NULL DEFAULT false,
  version bigint NOT NULL DEFAULT 1 CHECK (version>0),
  last_error text, created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date IS NULL OR end_date>=anchor_date)
);
CREATE TABLE recurring_occurrence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES entity(id), ledger_id uuid NOT NULL REFERENCES ledger(id),
  template_id uuid NOT NULL REFERENCES recurring_template(id), scheduled_for date NOT NULL,
  template_version bigint NOT NULL,
  target_invoice_id uuid REFERENCES invoice(id) ON DELETE SET NULL,
  target_entry_id uuid REFERENCES journal_entry(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(target_invoice_id,target_entry_id)<=1),
  UNIQUE (entity_id,ledger_id,template_id,scheduled_for)
);
CREATE TABLE inbox_item (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES entity(id), ledger_id uuid NOT NULL REFERENCES ledger(id),
  actor_user_id uuid REFERENCES app_user(id) ON DELETE SET NULL,
  sha256 text NOT NULL REFERENCES attachment_blob(sha256),
  filename text NOT NULL CHECK (length(filename) BETWEEN 1 AND 200),
  mime text NOT NULL CHECK (mime IN ('application/pdf','image/jpeg','image/png')),
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received','processing','needs_review','converted','failed','ignored')),
  reading_id uuid REFERENCES ai_bill_reading(id) ON DELETE SET NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version>0),
  corrections jsonb, duplicate_reason text, duplicate_override text,
  target_invoice_id uuid REFERENCES invoice(id) ON DELETE SET NULL,
  target_entry_id uuid REFERENCES journal_entry(id) ON DELETE SET NULL,
  converted_at timestamptz, converted_by text, last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(target_invoice_id,target_entry_id)<=1)
);
CREATE INDEX inbox_item_hash ON inbox_item(ledger_id,sha256);
ALTER TABLE ai_bill_reading ADD COLUMN used_invoice_id uuid REFERENCES invoice(id) ON DELETE SET NULL;
ALTER TABLE ai_bill_reading ADD CONSTRAINT reading_one_financial_target CHECK (num_nonnulls(used_entry_id,used_invoice_id)<=1);
CREATE TABLE reminder_rule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES entity(id), ledger_id uuid NOT NULL REFERENCES ledger(id),
  party_id uuid NOT NULL REFERENCES party(id), actor_user_id uuid REFERENCES app_user(id) ON DELETE SET NULL,
  enabled boolean NOT NULL DEFAULT false, paused boolean NOT NULL DEFAULT false,
  pause_reason text, defer_until date,
  days integer[] NOT NULL DEFAULT '{3,7,14}',
  start_hour integer NOT NULL DEFAULT 9 CHECK (start_hour BETWEEN 0 AND 23),
  end_hour integer NOT NULL DEFAULT 17 CHECK (end_hour BETWEEN 1 AND 24),
  version bigint NOT NULL DEFAULT 1 CHECK (version>0),
  CHECK (end_hour>start_hour), UNIQUE (ledger_id,party_id)
);
CREATE TABLE email_message (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES entity(id), ledger_id uuid NOT NULL REFERENCES ledger(id),
  actor_user_id uuid REFERENCES app_user(id) ON DELETE SET NULL,
  party_id uuid NOT NULL REFERENCES party(id), invoice_id uuid REFERENCES invoice(id) ON DELETE SET NULL,
  reminder_rule_id uuid REFERENCES reminder_rule(id) ON DELETE SET NULL,
  parent_message_id uuid REFERENCES email_message(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('invoice','open_statement','activity_statement','reminder')),
  request_key uuid NOT NULL, request_hash text NOT NULL,
  recipients text[] NOT NULL, cc text[] NOT NULL DEFAULT '{}',
  contact_fingerprint text NOT NULL, subject text NOT NULL, body text NOT NULL,
  attachment_sha256 text NOT NULL REFERENCES attachment_blob(sha256), attachment_name text NOT NULL,
  snapshot jsonb NOT NULL, invoice_version bigint,
  planned_date date,
  status text NOT NULL DEFAULT 'preview' CHECK (status IN ('preview','queued','sending','accepted','delivered','bounced','failed','delivery_unknown','skipped','paused')),
  message_id text, last_error text, accepted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (cardinality(recipients) BETWEEN 1 AND 10 AND cardinality(cc)<=10),
  UNIQUE (entity_id,ledger_id,actor_user_id,request_key)
);
CREATE TABLE background_job (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES entity(id), ledger_id uuid NOT NULL REFERENCES ledger(id),
  actor_user_id uuid REFERENCES app_user(id) ON DELETE SET NULL, request_id uuid NOT NULL DEFAULT gen_random_uuid(),
  job_type text NOT NULL CHECK (job_type IN ('inbox_extract','recurring_draft','email_send')),
  payload_schema_version integer NOT NULL DEFAULT 1 CHECK (payload_schema_version=1),
  payload jsonb NOT NULL DEFAULT '{}' CHECK (payload='{}'::jsonb),
  inbox_item_id uuid REFERENCES inbox_item(id), recurring_template_id uuid REFERENCES recurring_template(id),
  email_message_id uuid REFERENCES email_message(id), scheduled_for date,
  dedupe_key text NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 200),
  run_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','delivery_unknown','paused','skipped')),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt>=0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 5),
  locked_until timestamptz, generation bigint NOT NULL DEFAULT 0 CHECK (generation>=0),
  last_error text, result jsonb, created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((job_type='inbox_extract' AND inbox_item_id IS NOT NULL AND num_nonnulls(recurring_template_id,email_message_id)=0)
    OR (job_type='recurring_draft' AND recurring_template_id IS NOT NULL AND scheduled_for IS NOT NULL AND num_nonnulls(inbox_item_id,email_message_id)=0)
    OR (job_type='email_send' AND email_message_id IS NOT NULL AND num_nonnulls(inbox_item_id,recurring_template_id)=0)),
  UNIQUE (entity_id,ledger_id,job_type,dedupe_key)
);
CREATE INDEX background_job_ready ON background_job(status,run_at,locked_until);
CREATE TABLE automation_worker (
  id uuid PRIMARY KEY, heartbeat_at timestamptz NOT NULL DEFAULT now()
);

-- Explicit relations are checked in SQL as well as by the request/worker door.
CREATE FUNCTION assert_p2_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rowdata jsonb := to_jsonb(NEW); linked uuid; linked_ledger uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM ledger WHERE id=NEW.ledger_id AND entity_id=NEW.entity_id) THEN
    RAISE EXCEPTION 'P2_LEDGER_ENTITY';
  END IF;
  FOR linked, linked_ledger IN
    SELECT i.id,i.ledger_id FROM invoice i WHERE i.id=ANY(ARRAY[(rowdata->>'target_invoice_id')::uuid,(rowdata->>'invoice_id')::uuid])
    UNION ALL SELECT j.id,j.ledger_id FROM journal_entry j WHERE j.id=(rowdata->>'target_entry_id')::uuid
    UNION ALL SELECT r.id,r.ledger_id FROM recurring_template r WHERE r.id=ANY(ARRAY[(rowdata->>'template_id')::uuid,(rowdata->>'recurring_template_id')::uuid])
    UNION ALL SELECT n.id,n.ledger_id FROM inbox_item n WHERE n.id=(rowdata->>'inbox_item_id')::uuid
    UNION ALL SELECT m.id,m.ledger_id FROM email_message m WHERE m.id=ANY(ARRAY[(rowdata->>'email_message_id')::uuid,(rowdata->>'parent_message_id')::uuid])
    UNION ALL SELECT r.id,r.ledger_id FROM reminder_rule r WHERE r.id=(rowdata->>'reminder_rule_id')::uuid
    UNION ALL SELECT r.id,r.ledger_id FROM ai_bill_reading r WHERE r.id=(rowdata->>'reading_id')::uuid
  LOOP
    IF linked_ledger<>NEW.ledger_id THEN RAISE EXCEPTION 'P2_REFERENCE_LEDGER'; END IF;
  END LOOP;
  RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['recurring_template','recurring_occurrence','inbox_item','reminder_rule','email_message','background_job'] LOOP
    EXECUTE format('CREATE TRIGGER p2_scope BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION assert_p2_scope()',t);
  END LOOP;
END $$;
