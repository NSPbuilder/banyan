-- 0087 — a relationship belongs to one company, even when the name is shared.
--
-- Party remains the shared identity: one Acme, one legal name, one canonical
-- address. CRM rows are the relationship one FigTree company has with that
-- identity. Nothing in this migration posts to the ledger or changes a
-- party_role. A prospect is not an accounting customer merely because a
-- salesperson is speaking with them.

-- A set of companies and a set of modules described only their Cartesian
-- product. Keep those two old tables as compatibility summaries, but make this
-- matrix the authority so a person can hold CRM in A and Reports in B.
CREATE TABLE user_entity_module_access (
  user_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  entity_id  uuid NOT NULL REFERENCES entity(id),
  module     text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  granted_by text NOT NULL,
  PRIMARY KEY (user_id, entity_id, module)
);
CREATE INDEX user_entity_module_entity_idx
  ON user_entity_module_access (entity_id, module, user_id);

INSERT INTO user_entity_module_access (user_id, entity_id, module, granted_at, granted_by)
SELECT e.user_id, e.entity_id, m.module,
       GREATEST(e.granted_at, m.granted_at), m.granted_by
  FROM user_entity_access e JOIN user_module_access m ON m.user_id = e.user_id
ON CONFLICT DO NOTHING;

COMMENT ON TABLE user_entity_module_access IS
  'Authoritative company × nav-seat grants. user_entity_access and user_module_access are compatibility summaries.';

-- These composite keys let CRM references prove company ownership at the
-- database boundary, not merely that a role or invoice exists somewhere.
ALTER TABLE party_role ADD CONSTRAINT party_role_id_entity_unique UNIQUE (id, entity_id);
ALTER TABLE invoice ADD CONSTRAINT invoice_id_entity_unique UNIQUE (id, entity_id);

CREATE TABLE crm_pipeline (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id  uuid NOT NULL REFERENCES entity(id),
  name       text NOT NULL CHECK (length(btrim(name)) > 0),
  is_default boolean NOT NULL DEFAULT false,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL,
  UNIQUE (id, entity_id)
);
CREATE UNIQUE INDEX crm_one_default_pipeline
  ON crm_pipeline (entity_id) WHERE is_default;
CREATE UNIQUE INDEX crm_pipeline_name
  ON crm_pipeline (entity_id, lower(name)) WHERE is_active;

CREATE TABLE crm_stage (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id              uuid NOT NULL REFERENCES entity(id),
  pipeline_id            uuid NOT NULL,
  name                   text NOT NULL CHECK (length(btrim(name)) > 0),
  sort_order             integer NOT NULL CHECK (sort_order > 0),
  kind                   text NOT NULL DEFAULT 'open'
                           CHECK (kind IN ('open', 'won', 'lost')),
  default_probability_bp integer NOT NULL DEFAULT 0
                           CHECK (default_probability_bp BETWEEN 0 AND 10000),
  is_active              boolean NOT NULL DEFAULT true,
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             text NOT NULL,
  UNIQUE (id, entity_id),
  UNIQUE (id, pipeline_id, entity_id),
  UNIQUE (pipeline_id, sort_order),
  UNIQUE (pipeline_id, name),
  FOREIGN KEY (pipeline_id, entity_id) REFERENCES crm_pipeline(id, entity_id)
);

CREATE TABLE crm_account (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id     uuid NOT NULL REFERENCES entity(id),
  party_id      uuid NOT NULL REFERENCES party(id),
  lifecycle     text NOT NULL DEFAULT 'prospect'
                  CHECK (lifecycle IN ('prospect', 'active', 'dormant', 'lost')),
  owner_user_id uuid REFERENCES app_user(id) ON DELETE SET NULL,
  source        text,
  segment       text,
  territory     text,
  rating        text CHECK (rating IS NULL OR rating IN ('a', 'b', 'c')),
  website       text,
  version       integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text NOT NULL,
  archived_at   timestamptz,
  archived_by   text,
  UNIQUE (id, entity_id),
  UNIQUE (entity_id, party_id)
);
CREATE INDEX crm_account_owner_idx ON crm_account (entity_id, owner_user_id)
  WHERE archived_at IS NULL;

CREATE TABLE crm_lead (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id             uuid NOT NULL REFERENCES entity(id),
  organisation_name     text,
  person_name           text,
  email                 text,
  phone                 text,
  source                text,
  owner_user_id         uuid REFERENCES app_user(id) ON DELETE SET NULL,
  status                text NOT NULL DEFAULT 'new'
                          CHECK (status IN ('new', 'working', 'qualified', 'disqualified', 'converted')),
  disqualified_reason   text,
  converted_party_id    uuid REFERENCES party(id),
  converted_account_id  uuid,
  version               integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            text NOT NULL,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            text NOT NULL,
  UNIQUE (id, entity_id),
  FOREIGN KEY (converted_account_id, entity_id) REFERENCES crm_account(id, entity_id),
  CHECK (COALESCE(NULLIF(btrim(organisation_name), ''), NULLIF(btrim(person_name), '')) IS NOT NULL),
  CHECK ((status = 'converted') = (converted_party_id IS NOT NULL AND converted_account_id IS NOT NULL)),
  CHECK (status = 'disqualified' OR disqualified_reason IS NULL)
);
CREATE INDEX crm_lead_open_idx ON crm_lead (entity_id, status, created_at DESC)
  WHERE status NOT IN ('converted', 'disqualified');

CREATE TABLE crm_account_contact (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id        uuid NOT NULL REFERENCES entity(id),
  account_id       uuid NOT NULL,
  party_contact_id uuid REFERENCES party_contact(id),
  name             text NOT NULL CHECK (length(btrim(name)) > 0),
  job_title        text,
  decision_role    text,
  work_email       text,
  work_phone       text,
  preferred_channel text CHECK (preferred_channel IS NULL OR preferred_channel IN ('email', 'phone', 'other')),
  consent_status   text NOT NULL DEFAULT 'unknown'
                     CHECK (consent_status IN ('unknown', 'consented', 'declined', 'withdrawn')),
  consent_recorded_at timestamptz,
  notes            text,
  is_primary       boolean NOT NULL DEFAULT false,
  version          integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       text NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       text NOT NULL,
  UNIQUE (id, entity_id),
  FOREIGN KEY (account_id, entity_id) REFERENCES crm_account(id, entity_id),
  CHECK (COALESCE(NULLIF(btrim(work_email), ''), NULLIF(btrim(work_phone), '')) IS NOT NULL)
);
CREATE UNIQUE INDEX crm_one_primary_account_contact
  ON crm_account_contact (account_id) WHERE is_primary;

CREATE TABLE crm_opportunity (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id         uuid NOT NULL REFERENCES entity(id),
  account_id        uuid NOT NULL,
  pipeline_id       uuid NOT NULL,
  stage_id          uuid NOT NULL,
  name              text NOT NULL CHECK (length(btrim(name)) > 0),
  owner_user_id     uuid REFERENCES app_user(id) ON DELETE SET NULL,
  expected_amount   bigint CHECK (expected_amount IS NULL OR expected_amount >= 0),
  currency          text NOT NULL DEFAULT 'CAD' CHECK (currency ~ '^[A-Z]{3}$'),
  expected_close_on date,
  probability_bp    integer CHECK (probability_bp IS NULL OR probability_bp BETWEEN 0 AND 10000),
  source            text,
  description       text,
  closed_at         timestamptz,
  lost_reason       text,
  version           integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        text NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        text NOT NULL,
  archived_at       timestamptz,
  archived_by       text,
  UNIQUE (id, entity_id),
  FOREIGN KEY (account_id, entity_id) REFERENCES crm_account(id, entity_id),
  FOREIGN KEY (pipeline_id, entity_id) REFERENCES crm_pipeline(id, entity_id),
  FOREIGN KEY (stage_id, pipeline_id, entity_id) REFERENCES crm_stage(id, pipeline_id, entity_id)
);
CREATE INDEX crm_opportunity_stage_idx
  ON crm_opportunity (entity_id, pipeline_id, stage_id, expected_close_on)
  WHERE archived_at IS NULL;

CREATE TABLE crm_stage_event (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id      uuid NOT NULL REFERENCES entity(id),
  opportunity_id uuid NOT NULL,
  from_stage_id  uuid REFERENCES crm_stage(id),
  to_stage_id    uuid NOT NULL REFERENCES crm_stage(id),
  moved_at       timestamptz NOT NULL DEFAULT now(),
  moved_by       text NOT NULL,
  reason         text,
  UNIQUE (id, entity_id),
  FOREIGN KEY (opportunity_id, entity_id) REFERENCES crm_opportunity(id, entity_id)
);
CREATE INDEX crm_stage_event_opportunity_idx
  ON crm_stage_event (opportunity_id, moved_at);

CREATE TABLE crm_activity (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id      uuid NOT NULL REFERENCES entity(id),
  account_id     uuid,
  lead_id        uuid,
  opportunity_id uuid,
  kind           text NOT NULL CHECK (kind IN ('note', 'call', 'email', 'meeting')),
  direction      text CHECK (direction IS NULL OR direction IN ('inbound', 'outbound')),
  subject        text NOT NULL CHECK (length(btrim(subject)) > 0),
  body           text,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  actor_user_id  uuid REFERENCES app_user(id) ON DELETE SET NULL,
  external_provider text,
  external_id    text,
  version        integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     text NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     text NOT NULL,
  UNIQUE (id, entity_id),
  FOREIGN KEY (account_id, entity_id) REFERENCES crm_account(id, entity_id),
  FOREIGN KEY (lead_id, entity_id) REFERENCES crm_lead(id, entity_id),
  FOREIGN KEY (opportunity_id, entity_id) REFERENCES crm_opportunity(id, entity_id),
  CHECK (num_nonnulls(account_id, lead_id, opportunity_id) = 1)
);
CREATE INDEX crm_activity_time_idx ON crm_activity (entity_id, occurred_at DESC);
CREATE UNIQUE INDEX crm_activity_external_id
  ON crm_activity (entity_id, external_provider, external_id)
  WHERE external_provider IS NOT NULL AND external_id IS NOT NULL;

CREATE TABLE crm_task (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id       uuid NOT NULL REFERENCES entity(id),
  account_id      uuid,
  lead_id         uuid,
  opportunity_id  uuid,
  assigned_user_id uuid REFERENCES app_user(id) ON DELETE SET NULL,
  title           text NOT NULL CHECK (length(btrim(title)) > 0),
  due_at          timestamptz,
  priority        text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high')),
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  completed_at    timestamptz,
  completed_by    text,
  version         integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      text NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      text NOT NULL,
  UNIQUE (id, entity_id),
  FOREIGN KEY (account_id, entity_id) REFERENCES crm_account(id, entity_id),
  FOREIGN KEY (lead_id, entity_id) REFERENCES crm_lead(id, entity_id),
  FOREIGN KEY (opportunity_id, entity_id) REFERENCES crm_opportunity(id, entity_id),
  CHECK (num_nonnulls(account_id, lead_id, opportunity_id) = 1),
  CHECK ((status = 'done') = (completed_at IS NOT NULL))
);
CREATE INDEX crm_task_open_idx ON crm_task (entity_id, due_at, priority)
  WHERE status = 'open';

CREATE TABLE crm_finance_handoff (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id        uuid NOT NULL REFERENCES entity(id),
  opportunity_id   uuid NOT NULL,
  status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'accepted', 'rejected', 'cancelled')),
  requested_at     timestamptz NOT NULL DEFAULT now(),
  requested_by     text NOT NULL,
  reviewed_at      timestamptz,
  reviewed_by      text,
  review_reason    text,
  customer_role_id uuid,
  invoice_id       uuid,
  version          integer NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (id, entity_id),
  UNIQUE (opportunity_id),
  FOREIGN KEY (opportunity_id, entity_id) REFERENCES crm_opportunity(id, entity_id),
  FOREIGN KEY (customer_role_id, entity_id) REFERENCES party_role(id, entity_id),
  FOREIGN KEY (invoice_id, entity_id) REFERENCES invoice(id, entity_id),
  CHECK ((status = 'pending') = (reviewed_at IS NULL AND reviewed_by IS NULL))
);
CREATE INDEX crm_handoff_status_idx ON crm_finance_handoff (entity_id, status, requested_at);

CREATE TABLE crm_attachment (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id      uuid NOT NULL REFERENCES entity(id),
  account_id     uuid,
  lead_id        uuid,
  opportunity_id uuid,
  activity_id    uuid,
  sha256         text NOT NULL REFERENCES attachment_blob(sha256),
  original_name  text NOT NULL CHECK (length(btrim(original_name)) > 0),
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     text NOT NULL,
  UNIQUE (id, entity_id),
  FOREIGN KEY (account_id, entity_id) REFERENCES crm_account(id, entity_id),
  FOREIGN KEY (lead_id, entity_id) REFERENCES crm_lead(id, entity_id),
  FOREIGN KEY (opportunity_id, entity_id) REFERENCES crm_opportunity(id, entity_id),
  FOREIGN KEY (activity_id, entity_id) REFERENCES crm_activity(id, entity_id),
  CHECK (num_nonnulls(account_id, lead_id, opportunity_id, activity_id) = 1)
);

-- An archived company is readable and never writable. Unlike accounting's
-- original insert-only gate, CRM has ordinary edits, so all three mutations
-- are refused at the database boundary.
CREATE OR REPLACE FUNCTION check_crm_entity_open() RETURNS trigger AS $$
DECLARE
  company_id uuid;
  archived timestamptz;
  who text;
BEGIN
  company_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.entity_id ELSE NEW.entity_id END;
  IF current_setting('app.crm_load', true) = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  SELECT archived_at, name INTO archived, who FROM entity WHERE id = company_id;
  IF archived IS NOT NULL THEN
    RAISE EXCEPTION 'ENTITY_ARCHIVED: % was archived on %; bring it back before changing CRM records',
      who, archived::date;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'crm_pipeline', 'crm_stage', 'crm_account', 'crm_lead', 'crm_account_contact',
    'crm_opportunity', 'crm_stage_event', 'crm_activity', 'crm_task',
    'crm_finance_handoff', 'crm_attachment'
  ] LOOP
    EXECUTE format('CREATE TRIGGER trg_%I_entity_open BEFORE INSERT OR UPDATE OR DELETE ON %I '
      'FOR EACH ROW EXECUTE FUNCTION check_crm_entity_open()', t, t);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION forbid_crm_history_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'CRM_HISTORY_APPEND_ONLY: pipeline movement history is appended, not rewritten';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_crm_stage_event_immutable
  BEFORE UPDATE OR DELETE ON crm_stage_event
  FOR EACH ROW EXECUTE FUNCTION forbid_crm_history_change();

-- One ordinary pipeline for every company, now and in the future.
CREATE OR REPLACE FUNCTION seed_crm_pipeline_for_entity(company_id uuid) RETURNS void AS $$
DECLARE p uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM crm_pipeline WHERE entity_id = company_id AND is_default) THEN RETURN; END IF;
  INSERT INTO crm_pipeline (entity_id, name, is_default, created_by, updated_by)
  VALUES (company_id, 'Sales', true, 'migration:0087', 'migration:0087') RETURNING id INTO p;
  INSERT INTO crm_stage (entity_id, pipeline_id, name, sort_order, kind, default_probability_bp, created_by)
  VALUES
    (company_id, p, 'Qualifying', 10, 'open', 1000, 'migration:0087'),
    (company_id, p, 'Discovery', 20, 'open', 3000, 'migration:0087'),
    (company_id, p, 'Proposal', 30, 'open', 6000, 'migration:0087'),
    (company_id, p, 'Verbal yes', 40, 'open', 8500, 'migration:0087'),
    (company_id, p, 'Won', 50, 'won', 10000, 'migration:0087'),
    (company_id, p, 'Lost', 60, 'lost', 0, 'migration:0087');
END;
$$ LANGUAGE plpgsql;

-- Existing archived companies are intentionally seeded too: the CRM remains
-- readable while archived and is ready if the owner brings the company back.
-- The ordinary write gate stays closed; this flag is transaction-local to the
-- migration/load transaction.
SET LOCAL app.crm_load = 'on';
SELECT seed_crm_pipeline_for_entity(id) FROM entity;

CREATE OR REPLACE FUNCTION seed_crm_pipeline_on_entity() RETURNS trigger AS $$
BEGIN
  PERFORM seed_crm_pipeline_for_entity(NEW.id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_entity_seed_crm
  AFTER INSERT ON entity FOR EACH ROW EXECUTE FUNCTION seed_crm_pipeline_on_entity();

-- Existing accounting customers arrive as CRM accounts without changing a
-- role or inventing sales history. Their source says exactly why they exist.
INSERT INTO crm_account (entity_id, party_id, lifecycle, source, created_by, updated_by)
SELECT DISTINCT pr.entity_id, pr.party_id, 'active', 'Existing customer role',
       'migration:0087', 'migration:0087'
  FROM party_role pr
 WHERE pr.role = 'customer'
ON CONFLICT (entity_id, party_id) DO NOTHING;

INSERT INTO audit_log
  (actor, action, table_name, record_id, after, context, entity_id, scope, target_label)
SELECT 'migration:0087', 'crm_account_backfilled', 'crm_account', a.id::text,
       jsonb_build_object('partyId', a.party_id, 'lifecycle', a.lifecycle),
       jsonb_build_object('source', a.source), a.entity_id, 'company', p.name
  FROM crm_account a JOIN party p ON p.id = a.party_id
 WHERE a.created_by = 'migration:0087';
