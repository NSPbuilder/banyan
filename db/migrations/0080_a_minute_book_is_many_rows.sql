-- 0080 — a minute book is many rows.
--
-- The owner had a model read a minute book into the corporate records
-- (2026-09-16) and it could not put it anywhere: 「可能因为 corporate records
-- 不是表单」. A reading carried one flat map of facts, and the registers were
-- boxes on the page. Now each register has an add form of ROWS, and a reading
-- carries rows for each table it read (src/lib/record-rows.ts,
-- docs/design/41-every-add-is-a-form.md).
--
-- Two things the database has to hold for that.

-- -----------------------------------------------------------------------------
-- 1. Which of the record's tables a reading's rows have gone into.
--
-- The corporate record's counterpart of `used_entry_id` (0064). A reading of a
-- minute book fills several add forms, so "used" is not one entry but a set of
-- tables, each entered once: pressing Add on the directors form twice from the
-- same reading would appoint every director twice — or, for shares, issue
-- every share twice, which nothing downstream would refuse.
--
-- A map on the reading rather than a table beside it: the mark is about the
-- reading and dies with nothing else, and a new table would be a new row in
-- the company export and the company delete for a fact that is one key.
-- -----------------------------------------------------------------------------
ALTER TABLE ai_bill_reading
  ADD COLUMN records_entered jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE ai_bill_reading
  ADD CONSTRAINT ai_bill_reading_records_entered_is_a_map
  CHECK (jsonb_typeof(records_entered) = 'object');

COMMENT ON COLUMN ai_bill_reading.records_entered IS
  'The corporate-record tables this reading''s rows were entered into — '
  '{table: {at, by, rows}}. A table appears once; once there it stays (0080).';

-- A mark, once made, is not taken back or rewritten: the rows it records are in
-- the registers, and those do not leave. Written into the one guard (0064, as
-- 0077 last replaced it — every line of that version is here unchanged) so a
-- single function still says everything about what a reading may become.
--
-- THIS IS NOW THE LIVE COPY. A mutation block that edits 0077's text edits a
-- function this file replaces, and would run green against nothing — blocks 452
-- and 808 point here since this migration.
CREATE OR REPLACE FUNCTION guard_bill_reading_use() RETURNS trigger AS $$
DECLARE k text;
BEGIN
  IF OLD.used_entry_id IS NOT NULL AND NEW.used_entry_id IS NOT NULL
     AND NEW.used_entry_id IS DISTINCT FROM OLD.used_entry_id THEN
    RAISE EXCEPTION 'READING_ALREADY_USED: that bill was already entered as another entry';
  END IF;
  IF OLD.used_entry_id IS NOT NULL AND NEW.bytes IS DISTINCT FROM OLD.bytes THEN
    RAISE EXCEPTION 'READING_ALREADY_USED: the file behind an entered bill does not change';
  END IF;
  IF OLD.used_entry_id IS NOT NULL AND NEW.sentence IS DISTINCT FROM OLD.sentence THEN
    RAISE EXCEPTION 'READING_ALREADY_USED: the sentence behind an entered reading does not change';
  END IF;
  -- And the same for a reading whose rows went into the corporate record.
  IF OLD.records_entered <> '{}'::jsonb
     AND (NEW.bytes IS DISTINCT FROM OLD.bytes OR NEW.sentence IS DISTINCT FROM OLD.sentence) THEN
    RAISE EXCEPTION 'READING_ALREADY_USED: what an entered reading was read from does not change';
  END IF;
  FOR k IN SELECT jsonb_object_keys(OLD.records_entered) LOOP
    IF NEW.records_entered -> k IS DISTINCT FROM OLD.records_entered -> k THEN
      RAISE EXCEPTION 'READING_ALREADY_USED: the rows of that reading are already in the % table', k;
    END IF;
  END LOOP;
  IF NEW.used_entry_id IS NULL THEN
    NEW.used_at := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION guard_bill_reading_delete() RETURNS trigger AS $$
BEGIN
  IF OLD.used_entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'READING_ALREADY_USED: a bill that has been entered is kept; delete the entry instead';
  END IF;
  IF OLD.records_entered <> '{}'::jsonb THEN
    RAISE EXCEPTION 'READING_ALREADY_USED: a reading whose rows are in the corporate record is kept';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

-- -----------------------------------------------------------------------------
-- 2. Movements written in one transaction keep the order they were written in.
--
-- `check_holding_never_negative` (0035) walks a holder's history ordered by
-- (on_date, created_at, id). `now()` is the TRANSACTION's start, so every row
-- of one add form shared a created_at and the tie fell to a random uuid: an
-- issue of 100 and a transfer of 40 out, both dated the day of incorporation,
-- could be summed transfer-first and refused as an overdrawn holding that never
-- was. `clock_timestamp()` is the moment each row is written. A movement
-- entered alone, the only kind there was before today, is unaffected.
-- -----------------------------------------------------------------------------
ALTER TABLE share_transaction
  ALTER COLUMN created_at SET DEFAULT clock_timestamp();
