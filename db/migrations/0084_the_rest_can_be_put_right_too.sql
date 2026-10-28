-- 0084 — the rest can be put right too.
--
-- The owner (2026-09-16): 「所有的紀錄儘量都可以編輯刪除」. 0083 opened the
-- corporate record. This is what the other modules needed from the database
-- for the doors they were simply missing — asked about the locks, the owner
-- kept every one that guards posted, reconciled or filed books.

-- ---------------------------------------------------------------------------
-- Sales tax registrations: the number and the start date are correctable, a
-- registration entered by mistake can be deleted, and both are written to the
-- audit log beside the end-date changes that already were (0014, 0016).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION log_tax_registration() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO audit_log (actor, action, table_name, record_id, after, context)
    VALUES (NEW.created_by, 'register_tax', 'entity_tax_registration', NEW.id::text,
            jsonb_build_object('tax', NEW.tax, 'number', NEW.number,
                               'registered_on', NEW.registered_on),
            jsonb_build_object('entity_id', NEW.entity_id));
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    INSERT INTO audit_log (actor, action, table_name, record_id, before, context)
    VALUES (current_user, 'delete_tax_registration', 'entity_tax_registration', OLD.id::text,
            jsonb_build_object('tax', OLD.tax, 'number', OLD.number,
                               'registered_on', OLD.registered_on, 'ceased_on', OLD.ceased_on),
            jsonb_build_object('entity_id', OLD.entity_id));
    RETURN OLD;
  END IF;
  IF NEW.number IS DISTINCT FROM OLD.number OR NEW.registered_on IS DISTINCT FROM OLD.registered_on THEN
    INSERT INTO audit_log (actor, action, table_name, record_id, before, after, context)
    VALUES (current_user, 'correct_tax_registration', 'entity_tax_registration', NEW.id::text,
            jsonb_build_object('number', OLD.number, 'registered_on', OLD.registered_on),
            jsonb_build_object('number', NEW.number, 'registered_on', NEW.registered_on),
            jsonb_build_object('tax', NEW.tax, 'entity_id', NEW.entity_id));
  END IF;
  IF NEW.ceased_on IS DISTINCT FROM OLD.ceased_on THEN
    INSERT INTO audit_log (actor, action, table_name, record_id, before, after, context)
    VALUES (COALESCE(NEW.ceased_by, current_user),
            CASE WHEN NEW.ceased_on IS NULL THEN 'resume_tax_registration' ELSE 'cease_tax_registration' END,
            'entity_tax_registration', NEW.id::text,
            jsonb_build_object('ceased_on', OLD.ceased_on),
            jsonb_build_object('ceased_on', NEW.ceased_on),
            jsonb_build_object('tax', NEW.tax, 'entity_id', NEW.entity_id));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER trg_tax_registration_audit ON entity_tax_registration;
CREATE TRIGGER trg_tax_registration_audit
  AFTER INSERT OR UPDATE OR DELETE ON entity_tax_registration
  FOR EACH ROW EXECUTE FUNCTION log_tax_registration();
