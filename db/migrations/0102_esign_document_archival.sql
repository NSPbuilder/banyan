-- Local filing state is reversible. PDF content and signing history stay immutable.
ALTER TABLE esign_document ADD COLUMN document_archived_at timestamptz;
CREATE INDEX esign_document_filing ON esign_document(entity_id,document_archived_at,created_at DESC);

CREATE OR REPLACE FUNCTION esign_guard() RETURNS trigger AS $$
DECLARE e uuid; archived timestamptz;
BEGIN
  e := CASE WHEN TG_OP='DELETE' THEN OLD.entity_id ELSE NEW.entity_id END;
  SELECT archived_at INTO archived FROM entity WHERE id=e FOR SHARE;
  IF archived IS NOT NULL AND coalesce(current_setting('app.esign_sync',true),'') <> 'on' THEN
    RAISE EXCEPTION 'ESIGN_ARCHIVED: Company documents are read-only';
  END IF;
  IF TG_OP='UPDATE' AND NEW.entity_id<>OLD.entity_id THEN RAISE EXCEPTION 'ESIGN_SCOPE: Company cannot change'; END IF;
  IF TG_TABLE_NAME='esign_document' AND TG_OP<>'INSERT' THEN
    IF TG_OP='DELETE' THEN
      RAISE EXCEPTION 'ESIGN_IMMUTABLE: Documents cannot be deleted';
    END IF;
    IF (to_jsonb(NEW)-'document_archived_at') IS DISTINCT FROM (to_jsonb(OLD)-'document_archived_at') THEN
      RAISE EXCEPTION 'ESIGN_IMMUTABLE: Document content is immutable';
    END IF;
  END IF;
  IF TG_TABLE_NAME='esign_file' AND TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'ESIGN_IMMUTABLE: Signing evidence is immutable';
  END IF;
  IF TG_TABLE_NAME='esign_request' AND TG_OP='INSERT' THEN
    IF EXISTS (SELECT 1 FROM esign_document WHERE id=NEW.document_id AND entity_id=NEW.entity_id AND document_archived_at IS NOT NULL) THEN
      RAISE EXCEPTION 'ESIGN_ARCHIVED: Restore the document before creating a signing request';
    END IF;
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
