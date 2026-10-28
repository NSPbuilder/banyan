-- Append-only: worksheet cost categories and reversible project deletion.
ALTER TABLE project ADD COLUMN deleted_at timestamptz, ADD COLUMN deleted_by text;
ALTER TABLE project ADD CONSTRAINT project_deletion_actor CHECK ((deleted_at IS NULL) = (deleted_by IS NULL));
ALTER TABLE project_record_line DROP CONSTRAINT project_record_line_kind_check;
ALTER TABLE project_record_line ADD CONSTRAINT project_record_line_kind_check CHECK (kind IN ('revenue','material','labor','janitorial','other'));
ALTER TABLE project_record ALTER COLUMN party_id DROP NOT NULL;
ALTER TABLE project_payment ALTER COLUMN party_id DROP NOT NULL;
ALTER TABLE project_payment_allocation ALTER COLUMN party_id DROP NOT NULL;
ALTER TABLE project_record ADD CONSTRAINT project_revenue_party CHECK (kind <> 'revenue' OR party_id IS NOT NULL);
ALTER TABLE project_payment ADD CONSTRAINT project_receipt_party CHECK (direction <> 'received' OR party_id IS NOT NULL);
-- Nullable composite FKs skip their checks: retain scope independently of Party.
ALTER TABLE project_payment_allocation ADD CONSTRAINT project_allocation_payment_scope
  FOREIGN KEY (payment_id,entity_id,project_id) REFERENCES project_payment(id,entity_id,project_id);
ALTER TABLE project_payment_allocation ADD CONSTRAINT project_allocation_record_scope
  FOREIGN KEY (record_id,entity_id,project_id) REFERENCES project_record(id,entity_id,project_id);

CREATE OR REPLACE FUNCTION project_write_guard() RETURNS trigger AS $$
DECLARE e uuid; p uuid; company_archived timestamptz; project_status text; customer uuid; deleted timestamptz;
BEGIN
  e := CASE WHEN TG_OP='DELETE' THEN OLD.entity_id ELSE NEW.entity_id END;
  SELECT archived_at INTO company_archived FROM entity WHERE id=e FOR SHARE;
  IF company_archived IS NOT NULL THEN RAISE EXCEPTION 'PROJECT_COMPANY_ARCHIVED: Company is archived'; END IF;
  IF TG_OP='UPDATE' AND NEW.entity_id<>OLD.entity_id THEN RAISE EXCEPTION 'PROJECT_SCOPE: Company cannot change'; END IF;
  IF TG_TABLE_NAME='project' THEN
    IF TG_OP='UPDATE' AND OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'PROJECT_DELETED: Restore the project before editing';
    END IF;
    IF TG_OP='UPDATE' AND OLD.status='archived' AND NEW.status='archived'
      AND NEW.deleted_at IS NOT DISTINCT FROM OLD.deleted_at THEN
      RAISE EXCEPTION 'PROJECT_ARCHIVED: Restore the project before editing';
    END IF;
  ELSE
    p := CASE WHEN TG_OP='DELETE' THEN OLD.project_id ELSE NEW.project_id END;
    SELECT status,customer_party_id,deleted_at INTO project_status,customer,deleted FROM project
      WHERE id=p AND entity_id=e FOR UPDATE;
    IF deleted IS NOT NULL THEN RAISE EXCEPTION 'PROJECT_DELETED: Project is deleted'; END IF;
    IF project_status='archived' THEN RAISE EXCEPTION 'PROJECT_ARCHIVED: Project is archived'; END IF;
    IF TG_OP='UPDATE' AND NEW.project_id<>OLD.project_id THEN RAISE EXCEPTION 'PROJECT_SCOPE: Project cannot change'; END IF;
    IF TG_TABLE_NAME='project_record' AND TG_OP<>'DELETE' THEN
      IF NEW.kind='revenue' AND NEW.party_id IS DISTINCT FROM customer THEN
        RAISE EXCEPTION 'PROJECT_CUSTOMER: Revenue must name this project customer';
      END IF;
    END IF;
    IF TG_TABLE_NAME='project_payment' AND TG_OP<>'DELETE' THEN
      IF NEW.direction='received' AND NEW.party_id IS DISTINCT FROM customer THEN
        RAISE EXCEPTION 'PROJECT_CUSTOMER: Receipts must name this project customer';
      END IF;
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION project_validate(p uuid) RETURNS void AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM project_record r JOIN project x ON x.id=r.project_id
    WHERE x.id=p AND r.kind='revenue' AND r.party_id IS DISTINCT FROM x.customer_party_id)
    OR EXISTS (SELECT 1 FROM project_payment pay JOIN project x ON x.id=pay.project_id
    WHERE x.id=p AND pay.direction='received' AND pay.party_id IS DISTINCT FROM x.customer_party_id)
    THEN RAISE EXCEPTION 'PROJECT_CUSTOMER: Revenue and receipts must name the project customer'; END IF;
  IF EXISTS (SELECT 1 FROM project_record r JOIN project_record_line l ON l.record_id=r.id
    WHERE r.project_id=p AND r.party_id IS NULL AND l.kind<>'other')
    THEN RAISE EXCEPTION 'PROJECT_PARTY: Only Other costs may omit a Party'; END IF;
  IF EXISTS (
    SELECT 1 FROM project_payment_allocation a
    JOIN project_payment pay ON pay.id=a.payment_id JOIN project_record r ON r.id=a.record_id
    WHERE a.project_id=p AND a.state='active' AND
      (pay.state<>'active' OR r.state<>'active' OR a.party_id IS DISTINCT FROM pay.party_id OR a.party_id IS DISTINCT FROM r.party_id OR
       (pay.direction='received')<>(r.kind='revenue') OR a.effective_date<pay.payment_date OR a.effective_date<r.record_date)
  ) THEN RAISE EXCEPTION 'PROJECT_ALLOCATION: Allocation Party, direction, state or date is invalid'; END IF;
  IF EXISTS (SELECT 1 FROM project_payment pay WHERE pay.project_id=p AND
      (SELECT COALESCE(sum(a.amount_cents),0) FROM project_payment_allocation a WHERE a.payment_id=pay.id AND a.state='active')>pay.amount_cents)
    THEN RAISE EXCEPTION 'PROJECT_OVERPAYMENT: Allocations exceed the payment'; END IF;
  IF EXISTS (SELECT 1 FROM project_record r WHERE r.project_id=p AND r.state='active' AND (
      (SELECT COALESCE(sum(l.base_cents+l.gst_cents+l.pst_cents),0) FROM project_record_line l WHERE l.record_id=r.id)<=0 OR
      (SELECT COALESCE(sum(a.amount_cents),0) FROM project_payment_allocation a WHERE a.record_id=r.id AND a.state='active')>
      (SELECT COALESCE(sum(l.base_cents+l.gst_cents+l.pst_cents),0) FROM project_record_line l WHERE l.record_id=r.id) OR
      EXISTS (SELECT 1 FROM project_record_line l WHERE l.record_id=r.id AND (l.kind='revenue')<>(r.kind='revenue'))
    )) THEN RAISE EXCEPTION 'PROJECT_RECORD_TOTAL: Empty, misclassified or over-settled record'; END IF;
END;
$$ LANGUAGE plpgsql;
