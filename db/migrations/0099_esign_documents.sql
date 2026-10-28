-- Standalone company documents. No accounting entry is created by signing.
CREATE TABLE esign_connection (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL UNIQUE REFERENCES entity(id),
  key_enc bytea NOT NULL, webhook_hash text NOT NULL CHECK (webhook_hash ~ '^[a-f0-9]{64}$'),
  enabled boolean NOT NULL DEFAULT true, updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,entity_id)
);
CREATE TABLE esign_document (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), entity_id uuid NOT NULL REFERENCES entity(id),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 180),
  kind text NOT NULL CHECK (kind IN ('memo','contract','other')), note text,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0), supersedes_id uuid,
  submission_key uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), created_by text NOT NULL,
  UNIQUE(id,entity_id), UNIQUE(entity_id,submission_key),
  FOREIGN KEY(supersedes_id,entity_id) REFERENCES esign_document(id,entity_id)
);
CREATE TABLE esign_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), entity_id uuid NOT NULL, document_id uuid NOT NULL UNIQUE,
  connection_id uuid, remote_id text, team_url text,
  operation text NOT NULL DEFAULT 'LOCAL' CHECK (operation IN ('LOCAL','CREATING','UNCERTAIN','LINKED','DETACHED')),
  remote_status text CHECK (remote_status IN ('DRAFT','PENDING','COMPLETED','REJECTED','CANCELLED')),
  recipients jsonb NOT NULL DEFAULT '[]', snapshot jsonb,
  last_error text, synced_at timestamptz, next_sync_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0, completed_at timestamptz, archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), created_by text NOT NULL,
  FOREIGN KEY(document_id,entity_id) REFERENCES esign_document(id,entity_id),
  FOREIGN KEY(connection_id,entity_id) REFERENCES esign_connection(id,entity_id),
  UNIQUE(id,entity_id,document_id), UNIQUE(connection_id,remote_id),
  CHECK (operation <> 'LINKED' OR (connection_id IS NOT NULL AND remote_id IS NOT NULL))
);
CREATE TABLE esign_file (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), entity_id uuid NOT NULL, document_id uuid NOT NULL,
  request_id uuid, artifact_key text NOT NULL, kind text NOT NULL CHECK (kind IN ('source','original','signed','certificate','audit')),
  sha256 text NOT NULL REFERENCES attachment_blob(sha256), filename text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by text NOT NULL,
  FOREIGN KEY(document_id,entity_id) REFERENCES esign_document(id,entity_id),
  FOREIGN KEY(request_id,entity_id,document_id) REFERENCES esign_request(id,entity_id,document_id),
  UNIQUE(document_id,artifact_key),
  CHECK ((kind='source' AND request_id IS NULL AND artifact_key='source') OR (kind<>'source' AND request_id IS NOT NULL))
);
-- Notifications are hints to fetch authoritative state, never signing truth.
CREATE TABLE esign_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), entity_id uuid NOT NULL, connection_id uuid NOT NULL,
  remote_id text NOT NULL, event_hash text NOT NULL CHECK (event_hash ~ '^[a-f0-9]{64}$'),
  received_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz,
  FOREIGN KEY(connection_id,entity_id) REFERENCES esign_connection(id,entity_id),
  UNIQUE(connection_id,event_hash)
);
CREATE INDEX esign_document_by_company ON esign_document(entity_id,created_at DESC);
CREATE INDEX esign_request_due ON esign_request(next_sync_at) WHERE operation <> 'DETACHED' AND archived_at IS NULL;
CREATE INDEX esign_event_pending ON esign_event(received_at) WHERE processed_at IS NULL;

CREATE FUNCTION esign_guard() RETURNS trigger AS $$
DECLARE e uuid; archived timestamptz;
BEGIN
  e := CASE WHEN TG_OP='DELETE' THEN OLD.entity_id ELSE NEW.entity_id END;
  SELECT archived_at INTO archived FROM entity WHERE id=e FOR SHARE;
  IF archived IS NOT NULL AND coalesce(current_setting('app.esign_sync',true),'') <> 'on' THEN
    RAISE EXCEPTION 'ESIGN_ARCHIVED: Company documents are read-only';
  END IF;
  IF TG_OP='UPDATE' AND NEW.entity_id<>OLD.entity_id THEN RAISE EXCEPTION 'ESIGN_SCOPE: Company cannot change'; END IF;
  IF TG_TABLE_NAME IN ('esign_document','esign_file') AND TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'ESIGN_IMMUTABLE: Documents and signing evidence are immutable';
  END IF;
  IF TG_TABLE_NAME='esign_request' AND TG_OP='UPDATE' THEN
    IF NEW.document_id<>OLD.document_id OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
      OR (OLD.remote_id IS NOT NULL AND NEW.remote_id IS DISTINCT FROM OLD.remote_id) THEN
      RAISE EXCEPTION 'ESIGN_SCOPE: A signing request cannot change its document or provider';
    END IF;
    IF OLD.remote_status IN ('COMPLETED','REJECTED','CANCELLED') AND NEW.remote_status IS DISTINCT FROM OLD.remote_status THEN
      RAISE EXCEPTION 'ESIGN_TERMINAL: A finished request cannot return to an earlier status';
    END IF;
    IF OLD.operation='DETACHED' AND NEW.operation<>'DETACHED' THEN
      RAISE EXCEPTION 'ESIGN_DETACHED: Restored requests cannot reconnect';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['esign_connection','esign_document','esign_request','esign_file','esign_event'] LOOP
    EXECUTE format('CREATE TRIGGER esign_write_guard BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION esign_guard()',t);
  END LOOP;
END $$;
