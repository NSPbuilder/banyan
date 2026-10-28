-- 0077 · A sentence is enough (docs/design/38-a-sentence-to-the-books.md, 第二期).
--
-- AI Add reads what a person wrote, a document, or both: 「我告诉他一句话和附件，
-- 就可以做账了」. A reading from a sentence alone has no file, so the four file
-- columns may now be empty — all four together, never some — and the sentence
-- is kept beside them. At least one of the two is there; a reading of nothing
-- is not a reading.
--
-- The table keeps its name. `ai_bill_reading` says "a bill" and now also holds
-- a sentence about money coming in; renaming it would touch the backup lists,
-- the company delete gate, 0066's archive trigger and the search, for no change
-- in what anything does.
--
-- And a correction to 0064's header, which says the bytes live here "until the
-- reading is used or discarded". Using it does not remove them:
-- `attachReadingTo` files a copy through `saveAttachment` and the reading keeps
-- its own, which 0064's trigger refuses to change — so an entered reading's
-- picture is in the database twice, and in every backup twice. Only discarding
-- a reading nobody has entered removes it. A sentence stays the same way.

ALTER TABLE ai_bill_reading
  ALTER COLUMN filename DROP NOT NULL,
  ALTER COLUMN mime DROP NOT NULL,
  ALTER COLUMN bytes DROP NOT NULL,
  ALTER COLUMN sha256 DROP NOT NULL,
  ADD COLUMN sentence text;

ALTER TABLE ai_bill_reading
  ADD CONSTRAINT ai_bill_reading_file_whole
    CHECK ((filename IS NULL) = (mime IS NULL) AND (mime IS NULL) = (bytes IS NULL) AND (bytes IS NULL) = (sha256 IS NULL)),
  ADD CONSTRAINT ai_bill_reading_sentence_said CHECK (sentence IS NULL OR sentence ~ '[^[:space:]]'),
  ADD CONSTRAINT ai_bill_reading_something CHECK (bytes IS NOT NULL OR sentence IS NOT NULL);

-- 0064's guard, with the sentence beside the file: what an entered reading was
-- read from does not change, whichever of the two it was. Everything else is
-- as 0064 wrote it, including the one transition back to unused that the
-- entry's deletion performs.
CREATE OR REPLACE FUNCTION guard_bill_reading_use() RETURNS trigger AS $$
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
  IF NEW.used_entry_id IS NULL THEN
    NEW.used_at := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
