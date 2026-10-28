-- Engineering management records. No relationship to journal entries, accounts,
-- tax returns, payroll or accounting invoices. Shared identity stays in Party.
CREATE TABLE project (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES entity(id),
  code text NOT NULL CHECK (btrim(code) <> ''),
  name text NOT NULL CHECK (btrim(name) <> ''),
  customer_party_id uuid NOT NULL REFERENCES party(id),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  site text, start_date date, end_date date, note text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('planned','active','completed','archived')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(), created_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_id, code), UNIQUE (id, entity_id),
  CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);
CREATE TABLE project_record (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), entity_id uuid NOT NULL,
  project_id uuid NOT NULL, party_id uuid NOT NULL REFERENCES party(id),
  kind text NOT NULL CHECK (kind IN ('revenue','cost')),
  record_date date NOT NULL, due_date date, reference text, description text NOT NULL,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','void')),
  version integer NOT NULL DEFAULT 1, idempotency_key text, submission_hash text, created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, entity_id) REFERENCES project(id, entity_id),
  UNIQUE (entity_id, idempotency_key), UNIQUE (id, entity_id, project_id), UNIQUE (id, entity_id, project_id, party_id),
  CHECK (due_date IS NULL OR due_date >= record_date)
);
CREATE TABLE project_record_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), entity_id uuid NOT NULL, project_id uuid NOT NULL,
  record_id uuid NOT NULL, position integer NOT NULL CHECK (position > 0),
  kind text NOT NULL CHECK (kind IN ('revenue','material','labor')), description text NOT NULL,
  base_cents bigint NOT NULL CHECK (base_cents >= 0),
  gst_cents bigint NOT NULL DEFAULT 0 CHECK (gst_cents >= 0),
  pst_cents bigint NOT NULL DEFAULT 0 CHECK (pst_cents >= 0),
  gst_recoverable_cents bigint, pst_recoverable_cents bigint,
  FOREIGN KEY (record_id, entity_id, project_id) REFERENCES project_record(id, entity_id, project_id),
  UNIQUE (record_id, position),
  CHECK (gst_recoverable_cents BETWEEN 0 AND gst_cents),
  CHECK (pst_recoverable_cents BETWEEN 0 AND pst_cents)
);
CREATE TABLE project_payment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), entity_id uuid NOT NULL, project_id uuid NOT NULL,
  party_id uuid NOT NULL REFERENCES party(id), direction text NOT NULL CHECK (direction IN ('received','paid')),
  payment_date date NOT NULL, amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  method text, reference text, note text, state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','void')),
  version integer NOT NULL DEFAULT 1, idempotency_key text, submission_hash text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by text NOT NULL,
  FOREIGN KEY (project_id, entity_id) REFERENCES project(id, entity_id),
  UNIQUE (entity_id, idempotency_key), UNIQUE (id, entity_id, project_id), UNIQUE (id, entity_id, project_id, party_id)
);
CREATE TABLE project_payment_allocation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), entity_id uuid NOT NULL, project_id uuid NOT NULL,
  party_id uuid NOT NULL, payment_id uuid NOT NULL, record_id uuid NOT NULL,
  effective_date date NOT NULL, amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','void')),
  version integer NOT NULL DEFAULT 1, idempotency_key text, submission_hash text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by text NOT NULL,
  UNIQUE(entity_id,idempotency_key),
  FOREIGN KEY (payment_id, entity_id, project_id, party_id) REFERENCES project_payment(id, entity_id, project_id, party_id),
  FOREIGN KEY (record_id, entity_id, project_id, party_id) REFERENCES project_record(id, entity_id, project_id, party_id)
);
CREATE TABLE project_attachment_blob (
  entity_id uuid NOT NULL, project_id uuid NOT NULL, sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  byte_size bigint NOT NULL CHECK (byte_size > 0), mime text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_id, project_id, sha256),
  FOREIGN KEY (project_id, entity_id) REFERENCES project(id, entity_id)
);
CREATE TABLE project_attachment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), entity_id uuid NOT NULL, project_id uuid NOT NULL,
  record_id uuid, payment_id uuid, sha256 text NOT NULL, uploaded_filename text NOT NULL,
  note text, created_at timestamptz NOT NULL DEFAULT now(), created_by text NOT NULL,
  FOREIGN KEY (project_id, entity_id) REFERENCES project(id, entity_id),
  FOREIGN KEY (record_id, entity_id, project_id) REFERENCES project_record(id, entity_id, project_id),
  FOREIGN KEY (payment_id, entity_id, project_id) REFERENCES project_payment(id, entity_id, project_id),
  FOREIGN KEY (entity_id, project_id, sha256) REFERENCES project_attachment_blob(entity_id, project_id, sha256),
  CHECK (num_nonnulls(record_id, payment_id) <= 1)
);
CREATE INDEX project_record_by_project ON project_record(entity_id, project_id, record_date);
CREATE INDEX project_line_by_record ON project_record_line(record_id);
CREATE INDEX project_payment_by_project ON project_payment(entity_id, project_id, payment_date);
CREATE INDEX project_allocation_by_record ON project_payment_allocation(record_id);
CREATE INDEX project_allocation_by_payment ON project_payment_allocation(payment_id);

-- Every write serializes on the project, including direct SQL. Application
-- transactions use the same lock before calculating remaining amounts.
CREATE FUNCTION project_write_guard() RETURNS trigger AS $$
DECLARE e uuid; p uuid; company_archived timestamptz; project_status text; customer uuid;
BEGIN
  e := CASE WHEN TG_OP = 'DELETE' THEN OLD.entity_id ELSE NEW.entity_id END;
  SELECT archived_at INTO company_archived FROM entity WHERE id=e FOR SHARE;
  IF company_archived IS NOT NULL THEN RAISE EXCEPTION 'PROJECT_COMPANY_ARCHIVED: Company is archived'; END IF;
  IF TG_OP = 'UPDATE' AND NEW.entity_id <> OLD.entity_id THEN
    RAISE EXCEPTION 'PROJECT_SCOPE: Company cannot change';
  END IF;
  IF TG_TABLE_NAME = 'project' THEN
    IF TG_OP = 'UPDATE' AND OLD.status='archived' AND NEW.status='archived' THEN
      RAISE EXCEPTION 'PROJECT_ARCHIVED: Restore the project before editing';
    END IF;
  ELSE
    p := CASE WHEN TG_OP = 'DELETE' THEN OLD.project_id ELSE NEW.project_id END;
    SELECT status, customer_party_id INTO project_status, customer FROM project
      WHERE id=p AND entity_id=e FOR UPDATE;
    IF project_status='archived' THEN RAISE EXCEPTION 'PROJECT_ARCHIVED: Project is archived'; END IF;
    IF TG_OP='UPDATE' AND NEW.project_id <> OLD.project_id THEN RAISE EXCEPTION 'PROJECT_SCOPE: Project cannot change'; END IF;
    IF TG_TABLE_NAME='project_record' THEN
      IF TG_OP <> 'DELETE' AND NEW.kind='revenue' AND NEW.party_id <> customer THEN
        RAISE EXCEPTION 'PROJECT_CUSTOMER: Revenue must name this project customer';
      END IF;
    END IF;
    IF TG_TABLE_NAME='project_payment' THEN
      IF TG_OP <> 'DELETE' AND NEW.direction='received' AND NEW.party_id <> customer THEN
        RAISE EXCEPTION 'PROJECT_CUSTOMER: Receipts must name this project customer';
      END IF;
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['project','project_record','project_record_line','project_payment',
    'project_payment_allocation','project_attachment_blob','project_attachment'] LOOP
    EXECUTE format('CREATE TRIGGER project_guard BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION project_write_guard()',t);
  END LOOP;
END $$;

-- Deferred: inserting a header and its lines, and cancelling an erroneous
-- payment plus its allocations, can each complete in one transaction.
CREATE FUNCTION project_validate(p uuid) RETURNS void AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM project_record r JOIN project x ON x.id=r.project_id
    WHERE x.id=p AND r.kind='revenue' AND r.party_id<>x.customer_party_id)
    OR EXISTS (SELECT 1 FROM project_payment pay JOIN project x ON x.id=pay.project_id
    WHERE x.id=p AND pay.direction='received' AND pay.party_id<>x.customer_party_id)
    THEN RAISE EXCEPTION 'PROJECT_CUSTOMER: Revenue and receipts must name the project customer'; END IF;
  IF EXISTS (
    SELECT 1 FROM project_payment_allocation a
    JOIN project_payment pay ON pay.id=a.payment_id JOIN project_record r ON r.id=a.record_id
    WHERE a.project_id=p AND a.state='active' AND
      (pay.state<>'active' OR r.state<>'active' OR
       (pay.direction='received')<>(r.kind='revenue') OR a.effective_date < pay.payment_date OR a.effective_date < r.record_date)
  ) THEN RAISE EXCEPTION 'PROJECT_ALLOCATION: Allocation direction, state or date is invalid'; END IF;
  IF EXISTS (
    SELECT 1 FROM project_payment pay WHERE pay.project_id=p AND
      (SELECT COALESCE(sum(a.amount_cents),0) FROM project_payment_allocation a WHERE a.payment_id=pay.id AND a.state='active') > pay.amount_cents
  ) THEN RAISE EXCEPTION 'PROJECT_OVERPAYMENT: Allocations exceed the payment'; END IF;
  IF EXISTS (
    SELECT 1 FROM project_record r WHERE r.project_id=p AND r.state='active' AND (
      (SELECT COALESCE(sum(l.base_cents+l.gst_cents+l.pst_cents),0) FROM project_record_line l WHERE l.record_id=r.id) <= 0 OR
      (SELECT COALESCE(sum(a.amount_cents),0) FROM project_payment_allocation a WHERE a.record_id=r.id AND a.state='active') >
      (SELECT COALESCE(sum(l.base_cents+l.gst_cents+l.pst_cents),0) FROM project_record_line l WHERE l.record_id=r.id) OR
      EXISTS (SELECT 1 FROM project_record_line l WHERE l.record_id=r.id AND (l.kind='revenue')<>(r.kind='revenue'))
    )
  ) THEN RAISE EXCEPTION 'PROJECT_RECORD_TOTAL: Empty, misclassified or over-settled record'; END IF;
END;
$$ LANGUAGE plpgsql;
CREATE FUNCTION project_check_totals() RETURNS trigger AS $$
BEGIN
  PERFORM project_validate(CASE WHEN TG_OP='DELETE' THEN OLD.project_id ELSE NEW.project_id END);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['project_record','project_record_line','project_payment','project_payment_allocation'] LOOP
    EXECUTE format('CREATE CONSTRAINT TRIGGER project_totals AFTER INSERT OR UPDATE OR DELETE ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION project_check_totals()',t);
  END LOOP;
END $$;
