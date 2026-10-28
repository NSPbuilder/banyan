-- 0016 — who ended a registration
--
-- 0014 recorded the person who registered (`created_by`) but logged
-- `current_user` when a registration ended — the Postgres role, which is the
-- same string for everything the application does. "Registration ended
-- 30 April" with no one attached is the kind of gap that only matters once,
-- when someone asks why the return went quiet.
--
-- Same shape as fiscal_period.closed_by in 0003: the row carries the actor and
-- the trigger prefers it over the database role.

ALTER TABLE entity_tax_registration ADD COLUMN ceased_by text;

ALTER TABLE entity_tax_registration
  ADD CONSTRAINT entity_tax_registration_ceased_by
  CHECK (ceased_on IS NULL OR ceased_by IS NOT NULL);

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
