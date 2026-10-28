-- 0064 — a bill read, before anybody decides what it is.
--
-- The owner's ask (2026-09-06): 「上传一个invoice之后，自动做账，可能是立刻expense
-- 或者invoice做AP，让用户选择和review」 — upload a bill, have it read, then CHOOSE
-- between entering it as an expense paid now or as a bill in accounts payable,
-- and review before anything is entered.
--
-- So a reading is a thing that exists between the upload and the entry: the
-- file, what the model made of it, and nothing decided yet. It is not an
-- attachment — an attachment hangs off an entry, and there is no entry — so
-- the bytes live here until the reading is used or discarded. When it is
-- used, `saveAttachment` files the same bytes against the entry that was
-- posted and this row remembers which one; when it is discarded, the row and
-- its bytes go.
--
-- `proposal` is the model's own JSON as this system understood it: the lines,
-- the totals, the dates, what it guessed each line's account might be. It is
-- kept so that what the person reviewed is on record beside what they posted
-- — the difference between the two is the value of the review, and nobody can
-- see it if the proposal is thrown away.

CREATE TABLE ai_bill_reading (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_id    uuid NOT NULL REFERENCES ledger(id),
  exchange_id  uuid REFERENCES ai_exchange(id),
  read_by      text NOT NULL,
  read_at      timestamptz NOT NULL DEFAULT now(),
  filename     text NOT NULL,
  mime         text NOT NULL,
  bytes        bytea NOT NULL,
  sha256       text NOT NULL,
  proposal     jsonb,
  error        text,
  used_entry_id uuid REFERENCES journal_entry(id) ON DELETE SET NULL,
  used_at      timestamptz,
  CHECK ((used_entry_id IS NULL) = (used_at IS NULL))
);
CREATE INDEX ai_bill_reading_ledger_idx ON ai_bill_reading (ledger_id, read_at DESC);

-- A reading that has been used is finished: it may not be moved to another
-- entry or have its file changed. Deleting an unused one is how it is
-- discarded.
--
-- One transition IS allowed: back to unused. That is what the foreign key's
-- ON DELETE SET NULL does when the entry itself is deleted while its month is
-- open (posting.ts deleteEntry, the invoice's delete, a payment's), and it
-- arrives here as an UPDATE with used_entry_id NULL. The first version of
-- this trigger refused it, which made an entry with a bill filed against it
-- undeletable — the opposite of what its own message promised (critic). The
-- CHECK above ties used_at to used_entry_id, so this trigger clears it too;
-- the reading is then on the assistant page again, with both doors, which is
-- right: the entry is gone and the bill has not been entered.
CREATE OR REPLACE FUNCTION guard_bill_reading_use() RETURNS trigger AS $$
BEGIN
  IF OLD.used_entry_id IS NOT NULL AND NEW.used_entry_id IS NOT NULL
     AND NEW.used_entry_id IS DISTINCT FROM OLD.used_entry_id THEN
    RAISE EXCEPTION 'READING_ALREADY_USED: that bill was already entered as another entry';
  END IF;
  IF OLD.used_entry_id IS NOT NULL AND NEW.bytes IS DISTINCT FROM OLD.bytes THEN
    RAISE EXCEPTION 'READING_ALREADY_USED: the file behind an entered bill does not change';
  END IF;
  IF NEW.used_entry_id IS NULL THEN
    NEW.used_at := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_bill_reading_use
  BEFORE UPDATE ON ai_bill_reading
  FOR EACH ROW EXECUTE FUNCTION guard_bill_reading_use();

CREATE OR REPLACE FUNCTION guard_bill_reading_delete() RETURNS trigger AS $$
BEGIN
  IF OLD.used_entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'READING_ALREADY_USED: a bill that has been entered is kept; delete the entry instead';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_bill_reading_delete
  BEFORE DELETE ON ai_bill_reading
  FOR EACH ROW EXECUTE FUNCTION guard_bill_reading_delete();
