-- 0024 — where 0023's reason actually lives, and a note about citing by number
--
-- Nothing in the schema changes here. This file exists because 0023's header
-- says "Why: docs/design/08-opening-balances.md §3" and §3 of that document is
-- 「一列有符号金额，不是借方栏和贷方栏」 — the entry screen's shape, which has
-- nothing to do with what 0023 does.
--
-- The argument 0023 implements — an opening balance is a position, not a
-- transaction, so it cannot be what settles a bank row — is in §5, 「它是一张
-- 普通凭证，所以它会流到别处去」.
--
-- Migrations are append-only under a checksum, so 0023 cannot be corrected in
-- place; the correction goes in the next file. 0018 did the same for 0017.
--
-- Two things worth keeping from how this happened:
--
--   The pointer was wrong the day it was written, not broken later. §3 has been
--   the sign-convention section since the document was created. Adding §5 and §6
--   later made it look like drift; it was a bad citation from the start.
--
--   Section NUMBERS are the wrong thing to cite. A document that gains a section
--   renumbers everything below it, silently, and every migration pointing into
--   it is then wrong with no diff anywhere near the migration. From here on the
--   headers cite the section by its TITLE, which moves with the text it names.
--   The one below is the form to copy.
--
-- Why (0023): docs/design/08-opening-balances.md, 「它是一张普通凭证，所以它会
-- 流到别处去」.

DO $$ BEGIN
  -- A migration that changes nothing still has to be honest about that. If the
  -- guard 0023 installed is not there, this file is being applied to a database
  -- that never got it, and a comment correcting a reference is not the problem.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE proname = 'check_bank_match' AND prosrc LIKE '%ENTRY_IS_OPENING%')
  THEN
    RAISE EXCEPTION '0023 has not been applied here: check_bank_match does not refuse an opening balance';
  END IF;
END $$;
