-- Project remains a separate operational book. Only an explicit handoff
-- creates an accounting invoice; one revenue record can have one live link.
CREATE TABLE project_invoice_handoff (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL,
  project_id uuid NOT NULL,
  record_id uuid NOT NULL UNIQUE,
  invoice_id uuid NOT NULL UNIQUE,
  source_version integer NOT NULL CHECK (source_version > 0),
  source_snapshot jsonb NOT NULL CHECK (jsonb_typeof(source_snapshot) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  FOREIGN KEY (record_id, entity_id, project_id) REFERENCES project_record(id, entity_id, project_id),
  FOREIGN KEY (invoice_id, entity_id) REFERENCES invoice(id, entity_id) ON DELETE CASCADE
);
CREATE INDEX project_invoice_handoff_project ON project_invoice_handoff(entity_id, project_id);

CREATE FUNCTION check_project_invoice_handoff() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM project_record r JOIN invoice i ON i.id=NEW.invoice_id
    JOIN ledger l ON l.id=i.ledger_id
    WHERE r.id=NEW.record_id AND r.entity_id=NEW.entity_id AND r.project_id=NEW.project_id
      AND r.kind='revenue' AND r.state='active' AND r.version=NEW.source_version
      AND i.entity_id=r.entity_id AND l.entity_id=r.entity_id
      AND i.direction='sales' AND i.document_kind='invoice' AND i.party_id=r.party_id
  ) THEN RAISE EXCEPTION 'PROJECT_INVOICE_SCOPE: Handoff must link a current revenue record to its company customer invoice'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER project_invoice_handoff_scope BEFORE INSERT ON project_invoice_handoff
  FOR EACH ROW EXECUTE FUNCTION check_project_invoice_handoff();
