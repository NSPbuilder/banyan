-- P1 extends the existing identity and business objects. No ledger data rewrite.
ALTER TABLE app_user
  ADD COLUMN mfa_secret_ciphertext text,
  ADD COLUMN mfa_pending_ciphertext text,
  ADD COLUMN mfa_pending_until timestamptz,
  ADD COLUMN mfa_enabled_at timestamptz,
  ADD COLUMN mfa_last_counter bigint NOT NULL DEFAULT -1;
ALTER TABLE user_session ADD COLUMN reauthenticated_at timestamptz;

CREATE TABLE auth_rate_bucket (
  bucket_hash text PRIMARY KEY,
  attempts integer NOT NULL CHECK (attempts > 0),
  expires_at timestamptz NOT NULL
);
CREATE INDEX auth_rate_expiry ON auth_rate_bucket(expires_at);
CREATE TABLE auth_recovery_code (
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  consumed_at timestamptz,
  PRIMARY KEY(user_id, code_hash)
);

ALTER TABLE invoice ADD COLUMN version bigint NOT NULL DEFAULT 1 CHECK(version > 0);
ALTER TABLE journal_entry ADD COLUMN version bigint NOT NULL DEFAULT 1 CHECK(version > 0);
CREATE FUNCTION p1_bump_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.version := OLD.version + 1;
  RETURN NEW;
END $$;
CREATE TRIGGER p1_invoice_version BEFORE UPDATE ON invoice
  FOR EACH ROW EXECUTE FUNCTION p1_bump_version();
CREATE TRIGGER p1_entry_version BEFORE UPDATE ON journal_entry
  FOR EACH ROW EXECUTE FUNCTION p1_bump_version();

-- Changes below a header, including settlement, invalidate any old form.
CREATE FUNCTION p1_child_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ids uuid[]; target uuid;
BEGIN
  IF TG_TABLE_NAME = 'journal_line' THEN
    ids := ARRAY[CASE WHEN TG_OP <> 'INSERT' THEN OLD.entry_id END,
                 CASE WHEN TG_OP <> 'DELETE' THEN NEW.entry_id END];
    FOR target IN SELECT DISTINCT unnest(ids) ORDER BY 1 LOOP
      UPDATE journal_entry SET version = version WHERE id = target;
    END LOOP;
  ELSE
    ids := ARRAY[CASE WHEN TG_OP <> 'INSERT' THEN OLD.invoice_id END,
                 CASE WHEN TG_OP <> 'DELETE' THEN NEW.invoice_id END];
    FOR target IN SELECT DISTINCT unnest(ids) ORDER BY 1 LOOP
      UPDATE invoice SET version = version WHERE id = target;
    END LOOP;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER p1_invoice_line_version AFTER INSERT OR UPDATE OR DELETE ON invoice_line
  FOR EACH ROW EXECUTE FUNCTION p1_child_version();
CREATE TRIGGER p1_application_version AFTER INSERT OR UPDATE OR DELETE ON invoice_application
  FOR EACH ROW EXECUTE FUNCTION p1_child_version();
CREATE TRIGGER p1_journal_line_version AFTER INSERT OR UPDATE OR DELETE ON journal_line
  FOR EACH ROW EXECUTE FUNCTION p1_child_version();

CREATE TABLE document_edit_lease (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_id uuid NOT NULL REFERENCES ledger(id) ON DELETE CASCADE,
  invoice_id uuid UNIQUE REFERENCES invoice(id) ON DELETE CASCADE,
  journal_entry_id uuid UNIQUE REFERENCES journal_entry(id) ON DELETE CASCADE,
  holder_user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  session_hash text NOT NULL REFERENCES user_session(token_hash) ON DELETE CASCADE,
  tab_id uuid NOT NULL,
  token_hash text NOT NULL,
  generation bigint NOT NULL CHECK(generation > 0),
  expires_at timestamptz NOT NULL,
  last_active_at timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(invoice_id, journal_entry_id) = 1)
);
CREATE INDEX document_edit_expiry ON document_edit_lease(expires_at);
CREATE FUNCTION p1_lease_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.invoice_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM invoice WHERE id=NEW.invoice_id AND ledger_id=NEW.ledger_id
  ) OR NEW.journal_entry_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM journal_entry WHERE id=NEW.journal_entry_id AND ledger_id=NEW.ledger_id
  ) THEN RAISE EXCEPTION 'EDIT_LEASE_SCOPE'; END IF;
  IF NOT EXISTS (SELECT 1 FROM user_session WHERE token_hash=NEW.session_hash
                AND user_id=NEW.holder_user_id) THEN
    RAISE EXCEPTION 'EDIT_LEASE_SESSION';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER p1_lease_scope BEFORE INSERT OR UPDATE ON document_edit_lease
  FOR EACH ROW EXECUTE FUNCTION p1_lease_scope();
