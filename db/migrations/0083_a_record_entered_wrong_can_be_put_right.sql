-- 0083 — a record entered wrong can be put right.
--
-- The owner (2026-09-16): 「minute book不能修改編輯或者刪除欸。所有的紀錄儘量都可以
-- 編輯刪除」. The corporate record could only grow: a minute-book line typed with
-- the wrong date, a director read onto the wrong person, a share issue entered
-- twice — none had a way out but a correcting row, or nothing at all. Ceasing is
-- a date for something that HAPPENED; a mistake is not an event and should not
-- have to be recorded as one.
--
-- Asked about the securities register, which 0035 made append-only by trigger,
-- the owner chose: editable and deletable, keeping what it said. So:
--
--   1. The register still refuses a change from anywhere but its own Edit and
--      Delete. Those set `erp.register_edit` for their transaction — the way
--      `erp.open_edit` lets a posted entry change only through its door (0038).
--   2. Its two constraint triggers — a transfer nets to zero, nobody's holding
--      goes negative on any day — judged only INSERTs, and only NEW. They now
--      judge every change, on both the row as it was and the row as it is: an
--      issue deleted from under a later transfer leaves that holder negative.
--   3. Every change to and removal of a corporate-record row is written to the
--      audit log with the row before and after, by trigger, so the trail does
--      not depend on a door remembering. The private fields stay out, by the
--      visibility table, as 0036 does for inserts.

-- 1 --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION forbid_share_transaction_change() RETURNS trigger AS $$
BEGIN
  IF COALESCE(current_setting('erp.register_edit', true), '') = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'SHARES_APPEND_ONLY: the securities register changes only through its Edit and Delete, which keep what it said';
END $$ LANGUAGE plpgsql;

-- 2 --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_transfer_group() RETURNS trigger AS $$
DECLARE total bigint; classes int; days int; rows_left int; g uuid;
BEGIN
  FOREACH g IN ARRAY ARRAY[
    CASE WHEN TG_OP <> 'DELETE' THEN NEW.transfer_group END,
    CASE WHEN TG_OP <> 'INSERT' THEN OLD.transfer_group END]
  LOOP
    CONTINUE WHEN g IS NULL;
    SELECT COALESCE(SUM(delta), 0), COUNT(DISTINCT share_class_id), COUNT(DISTINCT on_date), COUNT(*)
      INTO total, classes, days, rows_left
      FROM share_transaction WHERE transfer_group = g;
    -- A transfer removed whole leaves nothing to judge.
    CONTINUE WHEN rows_left = 0;
    IF total <> 0 THEN
      RAISE EXCEPTION 'TRANSFER_UNBALANCED: the transfer group nets to % shares; a transfer moves shares, it does not mint them', total;
    END IF;
    IF classes <> 1 OR days <> 1 THEN
      RAISE EXCEPTION 'TRANSFER_MIXED: one transfer, one class, one day';
    END IF;
  END LOOP;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION check_holding_never_negative() RETURNS trigger AS $$
DECLARE bad record; pair record;
BEGIN
  FOR pair IN
    SELECT DISTINCT c, p FROM (VALUES
      (CASE WHEN TG_OP <> 'DELETE' THEN NEW.share_class_id END, CASE WHEN TG_OP <> 'DELETE' THEN NEW.party_id END),
      (CASE WHEN TG_OP <> 'INSERT' THEN OLD.share_class_id END, CASE WHEN TG_OP <> 'INSERT' THEN OLD.party_id END)
    ) AS x(c, p) WHERE c IS NOT NULL
  LOOP
    FOR bad IN
      SELECT on_date, SUM(delta) OVER (ORDER BY on_date, created_at, id) AS running
        FROM share_transaction
       WHERE share_class_id = pair.c AND party_id = pair.p
    LOOP
      IF bad.running < 0 THEN
        RAISE EXCEPTION 'SHARES_OVERDRAWN: that holder would be at % shares on %; nobody transfers shares they do not hold',
          bad.running, bad.on_date;
      END IF;
    END LOOP;
  END LOOP;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER trg_transfer_group ON share_transaction;
CREATE CONSTRAINT TRIGGER trg_transfer_group
  AFTER INSERT OR UPDATE OR DELETE ON share_transaction
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_transfer_group();

DROP TRIGGER trg_holding_never_negative ON share_transaction;
CREATE CONSTRAINT TRIGGER trg_holding_never_negative
  AFTER INSERT OR UPDATE OR DELETE ON share_transaction
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_holding_never_negative();

-- 3 --------------------------------------------------------------------------
-- The actor is the database role here, and `audit_actor_from_setting` (0060)
-- swaps it for the person the transaction says is acting.
CREATE OR REPLACE FUNCTION log_corporate_record_correction() RETURNS trigger AS $$
DECLARE
  was jsonb := to_jsonb(OLD);
  now_is jsonb := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(NEW) END;
  f record;
BEGIN
  FOR f IN SELECT DISTINCT field FROM register_field_visibility WHERE visibility = 'private'
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

CREATE TRIGGER trg_minute_book_correction
  AFTER UPDATE OR DELETE ON minute_book_entry
  FOR EACH ROW EXECUTE FUNCTION log_corporate_record_correction();
CREATE TRIGGER trg_corporate_office_correction
  AFTER UPDATE OR DELETE ON corporate_office
  FOR EACH ROW EXECUTE FUNCTION log_corporate_record_correction();
CREATE TRIGGER trg_directorship_correction
  AFTER UPDATE OR DELETE ON directorship
  FOR EACH ROW EXECUTE FUNCTION log_corporate_record_correction();
CREATE TRIGGER trg_significant_individual_correction
  AFTER UPDATE OR DELETE ON significant_individual
  FOR EACH ROW EXECUTE FUNCTION log_corporate_record_correction();
CREATE TRIGGER trg_share_transaction_correction
  AFTER UPDATE OR DELETE ON share_transaction
  FOR EACH ROW EXECUTE FUNCTION log_corporate_record_correction();
CREATE TRIGGER trg_share_class_correction
  AFTER UPDATE OR DELETE ON share_class
  FOR EACH ROW EXECUTE FUNCTION log_corporate_record_correction();

COMMENT ON FUNCTION forbid_share_transaction_change() IS
  'The securities register changes only inside a transaction that set erp.register_edit — its Edit and Delete doors, and a company delete (0083).';
