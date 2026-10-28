-- 0065 — a company can be put away, and an empty one can be removed.
--
-- The owner's ask (2026-09-07): 「需要一个删除/archive公司的功能」. Two
-- different things, and the difference is whether anything was ever posted.
--
-- ARCHIVE is for a company whose books exist and are finished with: a
-- dissolved corporation, a numbered company that never traded, last year's
-- structure. Nothing may be posted into it again and it leaves the list, but
-- every entry, statement and filing stays exactly where it was — because that
-- is the whole reason to keep books, and because the CRA can ask about them
-- for six years after the year they relate to.
--
-- DELETE is for a mistake: a company created with the wrong name or the wrong
-- year end, before anything was entered. `deleteCompany` refuses one that has
-- ever had a journal entry, and says to archive it instead. There is no door
-- that removes posted books, and there should not be one.
--
-- ONE TRUTH for "is it put away". `entity.is_active` has been the flag since
-- 0001 and a dozen queries filter on it; `archived_at` is the fact, with who
-- and why beside it. Rather than keep both and let them disagree, is_active
-- becomes a GENERATED column over archived_at: every existing query goes on
-- reading it, and there is exactly one place the answer comes from.

ALTER TABLE entity
  ADD COLUMN archived_at     timestamptz,
  ADD COLUMN archived_by     text,
  ADD COLUMN archived_reason text;

-- Whatever was already inactive was archived, at a time nobody recorded.
UPDATE entity SET archived_at = updated_at, archived_by = 'before 0065',
                  archived_reason = 'marked inactive before archiving had a record'
 WHERE NOT is_active;

ALTER TABLE entity DROP COLUMN is_active;
ALTER TABLE entity
  ADD COLUMN is_active boolean NOT NULL GENERATED ALWAYS AS (archived_at IS NULL) STORED;

ALTER TABLE entity
  ADD CONSTRAINT entity_archived_together
  CHECK ((archived_at IS NULL) = (archived_by IS NULL));

-- Nothing enters an archived company's books. The gate is on the entry rather
-- than on the screens: a screen can be reached by a URL, and `postEntryCore`
-- is the one door every posting goes through, but the trigger answers for
-- hand-written SQL and for any door written later.
CREATE OR REPLACE FUNCTION check_entity_archived() RETURNS trigger AS $$
DECLARE
  archived timestamptz;
  who text;
BEGIN
  SELECT e.archived_at, e.name INTO archived, who
    FROM ledger l JOIN entity e ON e.id = l.entity_id
   WHERE l.id = NEW.ledger_id;
  IF archived IS NOT NULL THEN
    RAISE EXCEPTION 'ENTITY_ARCHIVED: % was archived on %; bring it back before posting into it',
      who, archived::date;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_entry_entity_archived
  BEFORE INSERT ON journal_entry
  FOR EACH ROW EXECUTE FUNCTION check_entity_archived();

-- And no new fiscal year either: a year opened in an archived company is a
-- period nothing can be posted into, which is a promise the screen cannot keep.
CREATE TRIGGER trg_year_entity_archived
  BEFORE INSERT ON fiscal_year
  FOR EACH ROW EXECUTE FUNCTION check_entity_archived();
