-- 0085 — the trail strips only what ITS register calls private.
--
-- 0036 took the private fields out of every corporate-record audit row, and
-- 0083 did the same for changes and removals — both by asking which fields ANY
-- register marks private. The visibility table is per register, and a field
-- name private on one is public on another: `name` is private on the
-- transparency and securities registers, `ceased_on` on transparency. So a
-- share class renamed wrote a change row with no name before or after, and a
-- director's end date — public on the directors register — was missing from
-- every change row, leaving a cease or a corrected end date indistinguishable
-- from nothing (independent critic, 2026-09-17).
--
-- Each table now strips the private fields of the register it belongs to, and
-- a table that belongs to none strips nothing:
--
--   significant_individual  transparency
--   share_transaction       central_securities
--   directorship            directors            (nothing private today)
--   minute_book_entry, corporate_office, share_class   —

CREATE OR REPLACE FUNCTION corporate_record_register(p_table text) RETURNS text AS $$
  SELECT CASE p_table
    WHEN 'significant_individual' THEN 'transparency'
    WHEN 'share_transaction'      THEN 'central_securities'
    WHEN 'directorship'           THEN 'directors'
  END;
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION log_corporate_record_change() RETURNS trigger AS $$
DECLARE
  payload jsonb;
  f record;
BEGIN
  payload := to_jsonb(NEW);
  FOR f IN SELECT field FROM register_field_visibility
            WHERE visibility = 'private' AND register = corporate_record_register(TG_TABLE_NAME)
  LOOP
    payload := payload - f.field;
  END LOOP;

  INSERT INTO audit_log (actor, action, table_name, record_id, after)
  VALUES (COALESCE(NEW.created_by, 'system'),
          'record_' || TG_TABLE_NAME, TG_TABLE_NAME, NEW.id::text, payload);
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION log_corporate_record_correction() RETURNS trigger AS $$
DECLARE
  was jsonb := to_jsonb(OLD);
  now_is jsonb := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(NEW) END;
  f record;
BEGIN
  FOR f IN SELECT field FROM register_field_visibility
            WHERE visibility = 'private' AND register = corporate_record_register(TG_TABLE_NAME)
  LOOP
    was := was - f.field;
    now_is := now_is - f.field;
  END LOOP;
  INSERT INTO audit_log (actor, action, table_name, record_id, before, after)
  VALUES (current_user::text,
          CASE TG_OP WHEN 'UPDATE' THEN 'change_' ELSE 'delete_' END || TG_TABLE_NAME,
          TG_TABLE_NAME, OLD.id::text, was, now_is);
  RETURN NULL;
END $$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- A party's role: who changed it, what it was, and its removal (0084's doors).
-- The role trigger named the person who GRANTED a role on every later change
-- (`COALESCE(NEW.created_by, …)`), wrote no before, and watched no DELETE, so a
-- role's dates corrected or the role deleted left either somebody else's name
-- or nothing (independent critic, 2026-09-17). A change and a removal now name
-- whoever is acting (0060 swaps the role for them) with the row as it was.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION log_party_role_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO audit_log (actor, action, table_name, record_id, after, context)
    VALUES (COALESCE(NEW.created_by, current_user), 'grant_party_role', 'party_role', NEW.id::text,
            jsonb_build_object('role', NEW.role, 'held_from', NEW.held_from, 'held_to', NEW.held_to),
            jsonb_build_object('party_id', NEW.party_id, 'entity_id', NEW.entity_id));
    RETURN NEW;
  END IF;
  INSERT INTO audit_log (actor, action, table_name, record_id, before, after, context)
  VALUES (current_user,
          CASE TG_OP WHEN 'UPDATE' THEN 'amend_party_role' ELSE 'delete_party_role' END,
          'party_role', OLD.id::text,
          jsonb_build_object('role', OLD.role, 'held_from', OLD.held_from, 'held_to', OLD.held_to),
          CASE WHEN TG_OP = 'UPDATE'
               THEN jsonb_build_object('role', NEW.role, 'held_from', NEW.held_from, 'held_to', NEW.held_to) END,
          jsonb_build_object('party_id', OLD.party_id, 'entity_id', OLD.entity_id));
  RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER trg_party_role_audit ON party_role;
CREATE TRIGGER trg_party_role_audit
  AFTER INSERT OR UPDATE OR DELETE ON party_role
  FOR EACH ROW EXECUTE FUNCTION log_party_role_change();
