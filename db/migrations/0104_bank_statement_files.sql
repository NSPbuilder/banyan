-- Bank originals use the existing content-addressed store, bound to the
-- statement ending date rather than a journal entry or the upload month.
CREATE TABLE bank_statement_attachment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  statement_id uuid NOT NULL REFERENCES bank_statement(id),
  sha256 text NOT NULL REFERENCES attachment_blob(sha256),
  filename text NOT NULL CHECK (length(filename) BETWEEN 1 AND 255),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL DEFAULT 'system',
  CONSTRAINT bank_statement_attachment_once UNIQUE (statement_id, sha256)
);

-- Serialize SQL callers with Finish / Undo as well as the application doors.
-- Paper may arrive after Finish; removing it requires Undo first. Bindings
-- cannot be rewritten to bypass that rule or move paper to another account.
CREATE FUNCTION guard_bank_statement_attachment() RETURNS trigger AS $$
DECLARE
  account uuid;
  statement_day date;
  frozen date;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'STATEMENT_FILE_IMMUTABLE: Remove and upload the file again.';
  END IF;
  SELECT account_id INTO account FROM bank_statement
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.statement_id ELSE NEW.statement_id END;
  PERFORM pg_advisory_xact_lock(hashtextextended('bank_account:' || account::text, 0));
  IF TG_OP = 'DELETE' THEN
    SELECT statement_date INTO statement_day FROM bank_statement WHERE id = OLD.statement_id;
    frozen := bank_frozen_through(account);
    IF statement_day <= frozen THEN
      RAISE EXCEPTION 'RECONCILED: Undo the reconciliation of % before removing its statement file.', frozen;
    END IF;
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER bank_statement_attachment_guard
  BEFORE INSERT OR UPDATE OR DELETE ON bank_statement_attachment
  FOR EACH ROW EXECUTE FUNCTION guard_bank_statement_attachment();

COMMENT ON TABLE bank_statement_attachment IS
  'Bank statement originals, privately stored on attachment_blob. Derived tree: '
  '<company>/Bank statements/<account code and name plus UUID>/<YYYY-MM>/<date and attachment UUID>.<ext>.';
