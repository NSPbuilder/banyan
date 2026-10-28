-- P5: external facts and limited capabilities, using the existing books and jobs.
CREATE TABLE payment_connection (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES entity(id), ledger_id uuid NOT NULL UNIQUE REFERENCES ledger(id),
  authorized_by uuid REFERENCES app_user(id),
  stripe_account_id text CHECK (stripe_account_id ~ '^acct_[A-Za-z0-9]+$'),
  mode text NOT NULL CHECK (mode IN ('test','live')), currency text NOT NULL DEFAULT 'CAD' CHECK (currency='CAD'),
  key_ciphertext bytea, webhook_ciphertext bytea,
  clearing_account_id uuid NOT NULL REFERENCES account(id), fee_account_id uuid NOT NULL REFERENCES account(id),
  bank_account_id uuid REFERENCES account(id), timezone text NOT NULL DEFAULT 'America/Vancouver',
  binding_attached boolean NOT NULL DEFAULT true, enabled boolean NOT NULL DEFAULT false,
  verified_at timestamptz, version bigint NOT NULL DEFAULT 1 CHECK (version>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT enabled OR (binding_attached AND stripe_account_id IS NOT NULL AND verified_at IS NOT NULL
    AND key_ciphertext IS NOT NULL AND webhook_ciphertext IS NOT NULL AND authorized_by IS NOT NULL))
);
CREATE UNIQUE INDEX payment_merchant_binding ON payment_connection(stripe_account_id,mode)
  WHERE binding_attached AND stripe_account_id IS NOT NULL;

CREATE TABLE portal_invitation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), entity_id uuid NOT NULL REFERENCES entity(id),
  ledger_id uuid NOT NULL REFERENCES ledger(id), invoice_id uuid NOT NULL REFERENCES invoice(id),
  party_id uuid NOT NULL REFERENCES party(id), token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL, revoked_at timestamptz, created_by uuid REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(), CHECK (expires_at>created_at)
);
CREATE TABLE portal_session (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), entity_id uuid NOT NULL REFERENCES entity(id),
  ledger_id uuid NOT NULL REFERENCES ledger(id), portal_invitation_id uuid NOT NULL REFERENCES portal_invitation(id),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE checkout_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), entity_id uuid NOT NULL REFERENCES entity(id), ledger_id uuid NOT NULL REFERENCES ledger(id),
  payment_connection_id uuid NOT NULL REFERENCES payment_connection(id), invoice_id uuid NOT NULL REFERENCES invoice(id),
  party_id uuid NOT NULL REFERENCES party(id), invoice_version bigint NOT NULL CHECK (invoice_version>0),
  expected_amount bigint NOT NULL CHECK (expected_amount>0), currency text NOT NULL CHECK (currency='CAD'),
  stripe_account_id text NOT NULL, mode text NOT NULL CHECK (mode IN ('test','live')),
  source_request_key text NOT NULL, stripe_checkout_id text, payment_intent_id text, checkout_url text,
  status text NOT NULL DEFAULT 'creating' CHECK (status IN ('creating','open','invalidated','expired','paid','needs_accounting_review','failed','detached')),
  expires_at timestamptz, last_error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(payment_connection_id,source_request_key), UNIQUE(payment_connection_id,stripe_checkout_id), UNIQUE(payment_connection_id,payment_intent_id)
);
CREATE UNIQUE INDEX checkout_one_active_invoice ON checkout_request(invoice_id) WHERE status IN ('creating','open');

CREATE TABLE payment_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), entity_id uuid NOT NULL REFERENCES entity(id), ledger_id uuid NOT NULL REFERENCES ledger(id),
  payment_connection_id uuid NOT NULL REFERENCES payment_connection(id),
  stripe_account_id text NOT NULL, mode text NOT NULL CHECK (mode IN ('test','live')),
  provider_event_id text NOT NULL, event_type text NOT NULL, provider_object_id text NOT NULL,
  api_version text NOT NULL, snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot)='object' AND octet_length(snapshot::text)<=65536),
  source_hash text NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'), detached boolean NOT NULL DEFAULT false,
  received_at timestamptz NOT NULL DEFAULT now(), UNIQUE(payment_connection_id,provider_event_id)
);
CREATE UNIQUE INDEX payment_event_delivery ON payment_event(stripe_account_id,mode,provider_event_id) WHERE NOT detached;

CREATE TABLE processor_transaction (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), entity_id uuid NOT NULL REFERENCES entity(id), ledger_id uuid NOT NULL REFERENCES ledger(id),
  payment_connection_id uuid NOT NULL REFERENCES payment_connection(id), payment_event_id uuid REFERENCES payment_event(id),
  checkout_request_id uuid REFERENCES checkout_request(id), invoice_id uuid REFERENCES invoice(id),
  stripe_account_id text NOT NULL, mode text NOT NULL CHECK (mode IN ('test','live')),
  kind text NOT NULL CHECK (kind IN ('receipt','fee','payout','refund','dispute')),
  provider_object_id text NOT NULL, payment_intent_id text, balance_transaction_id text, payout_id text,
  amount bigint NOT NULL CHECK (amount>0), currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  occurred_at timestamptz NOT NULL, details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details)='object'),
  status text NOT NULL DEFAULT 'needs_accounting_review' CHECK (status IN ('needs_accounting_review','posted','matched','informational')),
  entry_id uuid REFERENCES journal_entry(id), accounting_date date, review_reason text, detached boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status IN ('posted','matched')) = (entry_id IS NOT NULL)),
  CHECK (entry_id IS NULL OR (currency='CAD' AND accounting_date IS NOT NULL)),
  UNIQUE(payment_connection_id,kind,provider_object_id)
);
CREATE UNIQUE INDEX processor_economic_event ON processor_transaction(stripe_account_id,mode,kind,provider_object_id) WHERE NOT detached;
CREATE INDEX processor_clearing_ledger ON processor_transaction(ledger_id,kind,status,occurred_at);

CREATE TABLE inbound_connection (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), entity_id uuid NOT NULL REFERENCES entity(id), ledger_id uuid NOT NULL UNIQUE REFERENCES ledger(id),
  authorized_by uuid REFERENCES app_user(id), provider_account text NOT NULL CHECK (length(provider_account) BETWEEN 1 AND 100),
  recipient_base text NOT NULL, alias_address text, username_ciphertext bytea, password_ciphertext bytea,
  enabled boolean NOT NULL DEFAULT false, binding_attached boolean NOT NULL DEFAULT true,
  version bigint NOT NULL DEFAULT 1 CHECK (version>0), created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT enabled OR (binding_attached AND authorized_by IS NOT NULL AND alias_address IS NOT NULL
    AND username_ciphertext IS NOT NULL AND password_ciphertext IS NOT NULL))
);
CREATE UNIQUE INDEX inbound_provider_binding ON inbound_connection(provider_account) WHERE binding_attached;
CREATE UNIQUE INDEX inbound_alias_binding ON inbound_connection(lower(alias_address)) WHERE alias_address IS NOT NULL AND binding_attached;
CREATE TABLE inbound_message (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), entity_id uuid NOT NULL REFERENCES entity(id), ledger_id uuid NOT NULL REFERENCES ledger(id),
  inbound_connection_id uuid NOT NULL REFERENCES inbound_connection(id), provider_message_id text NOT NULL,
  provider_account text NOT NULL, source_hash text NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
  sender text NOT NULL, subject text NOT NULL, recipient text NOT NULL, sent_at text,
  spam boolean NOT NULL DEFAULT false, status text NOT NULL CHECK (status IN ('received','quarantined','empty','rejected','detached')),
  note text NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), UNIQUE(inbound_connection_id,provider_message_id)
);
CREATE TABLE inbound_attachment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), entity_id uuid NOT NULL REFERENCES entity(id), ledger_id uuid NOT NULL REFERENCES ledger(id),
  inbound_message_id uuid NOT NULL REFERENCES inbound_message(id), attachment_no integer NOT NULL CHECK (attachment_no BETWEEN 0 AND 9),
  filename text NOT NULL, mime text NOT NULL, byte_count integer NOT NULL CHECK (byte_count>=0),
  sha256 text CHECK (sha256 ~ '^[a-f0-9]{64}$'), status text NOT NULL CHECK (status IN ('received','ignored','rejected')),
  reason text NOT NULL, inbox_item_id uuid UNIQUE REFERENCES inbox_item(id),
  UNIQUE(inbound_message_id,attachment_no), CHECK (inbox_item_id IS NULL OR (status='received' AND sha256 IS NOT NULL))
);

ALTER TABLE background_job ADD COLUMN payment_event_id uuid REFERENCES payment_event(id);
ALTER TABLE background_job DROP CONSTRAINT background_job_job_type_check;
ALTER TABLE background_job DROP CONSTRAINT background_job_check;
ALTER TABLE background_job ADD CONSTRAINT background_job_job_type_check CHECK (job_type IN ('inbox_extract','recurring_draft','email_send','payment_event'));
ALTER TABLE background_job ADD CONSTRAINT background_job_source_check CHECK (
  (job_type='inbox_extract' AND inbox_item_id IS NOT NULL AND num_nonnulls(recurring_template_id,email_message_id,payment_event_id)=0)
  OR (job_type='recurring_draft' AND recurring_template_id IS NOT NULL AND scheduled_for IS NOT NULL AND num_nonnulls(inbox_item_id,email_message_id,payment_event_id)=0)
  OR (job_type='email_send' AND email_message_id IS NOT NULL AND num_nonnulls(inbox_item_id,recurring_template_id,payment_event_id)=0)
  OR (job_type='payment_event' AND payment_event_id IS NOT NULL AND num_nonnulls(inbox_item_id,recurring_template_id,email_message_id)=0));

ALTER TABLE document_edit_lease ADD COLUMN payment_connection_id uuid REFERENCES payment_connection(id) ON DELETE CASCADE;
ALTER TABLE document_edit_lease ADD COLUMN inbound_connection_id uuid REFERENCES inbound_connection(id) ON DELETE CASCADE;
ALTER TABLE document_edit_lease DROP CONSTRAINT document_edit_lease_one_resource;
ALTER TABLE document_edit_lease ADD CONSTRAINT document_edit_lease_one_resource CHECK
  (num_nonnulls(invoice_id,journal_entry_id,inbox_item_id,recurring_template_id,reminder_rule_id,migration_run_id,budget_id,payment_connection_id,inbound_connection_id)=1);
CREATE UNIQUE INDEX edit_lease_payment_connection ON document_edit_lease(payment_connection_id) WHERE payment_connection_id IS NOT NULL;
CREATE UNIQUE INDEX edit_lease_inbound_connection ON document_edit_lease(inbound_connection_id) WHERE inbound_connection_id IS NOT NULL;

CREATE FUNCTION assert_p5_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r jsonb:=to_jsonb(NEW); linked_ledger uuid;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM ledger WHERE id=NEW.ledger_id AND entity_id=NEW.entity_id) THEN RAISE EXCEPTION 'P5_LEDGER_ENTITY'; END IF;
  FOR linked_ledger IN
    SELECT ledger_id FROM invoice WHERE id=(r->>'invoice_id')::uuid
    UNION ALL SELECT ledger_id FROM journal_entry WHERE id=(r->>'entry_id')::uuid
    UNION ALL SELECT ledger_id FROM payment_connection WHERE id=(r->>'payment_connection_id')::uuid
    UNION ALL SELECT ledger_id FROM inbound_connection WHERE id=(r->>'inbound_connection_id')::uuid
    UNION ALL SELECT ledger_id FROM portal_invitation WHERE id=(r->>'portal_invitation_id')::uuid
    UNION ALL SELECT ledger_id FROM checkout_request WHERE id=(r->>'checkout_request_id')::uuid
    UNION ALL SELECT ledger_id FROM payment_event WHERE id=(r->>'payment_event_id')::uuid
    UNION ALL SELECT ledger_id FROM inbound_message WHERE id=(r->>'inbound_message_id')::uuid
    UNION ALL SELECT ledger_id FROM inbox_item WHERE id=(r->>'inbox_item_id')::uuid
  LOOP IF linked_ledger<>NEW.ledger_id THEN RAISE EXCEPTION 'P5_REFERENCE_LEDGER'; END IF; END LOOP;
  IF r->>'party_id' IS NOT NULL AND r->>'invoice_id' IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM invoice WHERE id=(r->>'invoice_id')::uuid AND party_id=(r->>'party_id')::uuid) THEN RAISE EXCEPTION 'P5_INVOICE_PARTY'; END IF;
  IF TG_TABLE_NAME='payment_connection' THEN
    IF NOT EXISTS(SELECT 1 FROM account WHERE id=NEW.clearing_account_id AND entity_id=NEW.entity_id AND account_type='asset' AND is_active AND is_postable)
      OR NOT EXISTS(SELECT 1 FROM account WHERE id=NEW.fee_account_id AND entity_id=NEW.entity_id AND account_type='expense' AND is_active AND is_postable)
      OR NEW.clearing_account_id=NEW.fee_account_id THEN RAISE EXCEPTION 'P5_ACCOUNT_MAPPING'; END IF;
    IF NEW.bank_account_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM account a JOIN account_role ar ON ar.account_id=a.id
      WHERE a.id=NEW.bank_account_id AND a.entity_id=NEW.entity_id AND a.is_active AND ar.role='cash_and_cash_equivalents') THEN RAISE EXCEPTION 'P5_BANK_ACCOUNT'; END IF;
    IF EXISTS(SELECT 1 FROM account_role WHERE account_id=NEW.clearing_account_id AND role IN ('trade_receivables','trade_payables')) THEN RAISE EXCEPTION 'P5_CLEARING_CONTROL'; END IF;
    IF TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM checkout_request WHERE payment_connection_id=OLD.id AND status<>'detached')
      AND (NEW.stripe_account_id,NEW.mode,NEW.currency,NEW.clearing_account_id,NEW.fee_account_id)
        IS DISTINCT FROM (OLD.stripe_account_id,OLD.mode,OLD.currency,OLD.clearing_account_id,OLD.fee_account_id) THEN RAISE EXCEPTION 'P5_FROZEN_BINDING'; END IF;
  END IF;
  IF TG_OP='UPDATE' AND (NEW.entity_id,NEW.ledger_id) IS DISTINCT FROM (OLD.entity_id,OLD.ledger_id) THEN RAISE EXCEPTION 'P5_IDENTITY'; END IF;
  IF TG_OP='UPDATE' AND TG_TABLE_NAME IN ('portal_invitation','portal_session')
    AND (to_jsonb(NEW)-ARRAY['revoked_at','expires_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['revoked_at','expires_at']) THEN RAISE EXCEPTION 'P5_CAPABILITY_SCOPE'; END IF;
  IF TG_OP='UPDATE' AND TG_TABLE_NAME IN ('portal_invitation','portal_session')
    AND (NEW.expires_at>OLD.expires_at OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL)) THEN RAISE EXCEPTION 'P5_CAPABILITY_REVOCATION'; END IF;
  IF TG_OP='UPDATE' AND TG_TABLE_NAME='checkout_request'
    AND (to_jsonb(NEW)-ARRAY['status','stripe_checkout_id','payment_intent_id','checkout_url','expires_at','last_error','updated_at'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','stripe_checkout_id','payment_intent_id','checkout_url','expires_at','last_error','updated_at']) THEN RAISE EXCEPTION 'P5_REQUEST_SCOPE'; END IF;
  IF TG_TABLE_NAME='portal_invitation' AND TG_OP='INSERT' AND NOT EXISTS(SELECT 1 FROM invoice
    WHERE id=NEW.invoice_id AND status='posted' AND direction='sales' AND document_kind='invoice') THEN RAISE EXCEPTION 'P5_PUBLIC_INVOICE'; END IF;
  RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['payment_connection','portal_invitation','portal_session','checkout_request','payment_event','processor_transaction','inbound_connection','inbound_message','inbound_attachment'] LOOP
  EXECUTE format('CREATE TRIGGER p5_scope BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION assert_p5_scope()',t);
END LOOP; END $$;
CREATE TRIGGER p5_job_scope BEFORE INSERT OR UPDATE ON background_job FOR EACH ROW EXECUTE FUNCTION assert_p5_scope();

CREATE FUNCTION protect_p5_fact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE oldrow jsonb:=to_jsonb(OLD); newrow jsonb:=to_jsonb(NEW);
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'P5_FACT_IMMUTABLE'; END IF;
  IF TG_TABLE_NAME IN ('payment_event','inbound_message','inbound_attachment') AND newrow IS DISTINCT FROM oldrow THEN RAISE EXCEPTION 'P5_FACT_IMMUTABLE'; END IF;
  IF TG_TABLE_NAME='processor_transaction' THEN
    IF (newrow-ARRAY['status','entry_id','accounting_date','review_reason']) IS DISTINCT FROM (oldrow-ARRAY['status','entry_id','accounting_date','review_reason']) THEN RAISE EXCEPTION 'P5_ECONOMIC_FACT_IMMUTABLE'; END IF;
    IF OLD.entry_id IS NOT NULL AND (NEW.entry_id,NEW.accounting_date,NEW.status) IS DISTINCT FROM (OLD.entry_id,OLD.accounting_date,OLD.status) THEN RAISE EXCEPTION 'P5_POSTED_FACT_IMMUTABLE'; END IF;
    IF NEW.entry_id IS NOT NULL AND OLD.entry_id IS NULL AND COALESCE(current_setting('erp.processor_transaction',true),'')<>NEW.id::text THEN RAISE EXCEPTION 'P5_CONTROLLED_SETTLEMENT'; END IF;
  END IF;
  RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['payment_event','processor_transaction','inbound_message','inbound_attachment'] LOOP
  EXECUTE format('CREATE TRIGGER p5_fact_protection BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION protect_p5_fact()',t);
END LOOP; END $$;
