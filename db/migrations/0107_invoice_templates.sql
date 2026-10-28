-- Templates are installation resources with explicit company grants.
-- Invoice snapshots are portable and never depend on a live grant or version FK.
CREATE TABLE invoice_template (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES entity(id),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  is_active boolean NOT NULL DEFAULT true,
  current_version integer NOT NULL DEFAULT 1 CHECK (current_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(entity_id, name)
);

CREATE TABLE invoice_template_version (
  template_id uuid NOT NULL REFERENCES invoice_template(id),
  version integer NOT NULL CHECK (version > 0),
  name text NOT NULL,
  settings jsonb NOT NULL CHECK (jsonb_typeof(settings) = 'object'
    AND settings->>'layout' IN ('standard', 'compact')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  PRIMARY KEY(template_id, version)
);

CREATE FUNCTION invoice_template_version_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'TEMPLATE_VERSION_IMMUTABLE: create a new template version';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_invoice_template_version_immutable
  BEFORE UPDATE OR DELETE ON invoice_template_version
  FOR EACH ROW EXECUTE FUNCTION invoice_template_version_immutable();

CREATE TABLE invoice_template_access (
  template_id uuid NOT NULL REFERENCES invoice_template(id),
  entity_id uuid NOT NULL REFERENCES entity(id),
  can_use boolean NOT NULL DEFAULT true,
  can_edit boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL,
  PRIMARY KEY(template_id, entity_id),
  CHECK (NOT can_edit OR can_use)
);
CREATE INDEX invoice_template_access_company ON invoice_template_access(entity_id);

CREATE TABLE invoice_template_assignment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES entity(id),
  party_id uuid REFERENCES party(id),
  template_id uuid NOT NULL REFERENCES invoice_template(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL
);
CREATE UNIQUE INDEX invoice_template_company_default ON invoice_template_assignment(entity_id) WHERE party_id IS NULL;
CREATE UNIQUE INDEX invoice_template_customer_default ON invoice_template_assignment(entity_id, party_id) WHERE party_id IS NOT NULL;

ALTER TABLE invoice ADD COLUMN print_template_selection text NOT NULL DEFAULT 'auto'
  CHECK (print_template_selection IN ('auto', 'system')
    OR print_template_selection ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
ALTER TABLE invoice ADD COLUMN print_template_snapshot jsonb
  CHECK (print_template_snapshot IS NULL OR jsonb_typeof(print_template_snapshot) = 'object');

CREATE FUNCTION invoice_template_snapshot_frozen() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'draft' AND (
    NEW.print_template_selection IS DISTINCT FROM OLD.print_template_selection
    OR NEW.print_template_snapshot IS DISTINCT FROM OLD.print_template_snapshot
  ) THEN
    RAISE EXCEPTION 'TEMPLATE_SNAPSHOT_FROZEN: posted invoices keep their saved template';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_invoice_template_snapshot_frozen BEFORE UPDATE ON invoice
  FOR EACH ROW EXECUTE FUNCTION invoice_template_snapshot_frozen();

COMMENT ON COLUMN invoice.print_template_snapshot IS
  'Template id/name/version/settings fixed at posting. Legacy NULL uses the original standard layout. Carried in company backups without granting template access.';
