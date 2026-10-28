-- 0018 — what the gapless check actually protects against
--
-- The function body is unchanged. Only the explanation is, and it is being
-- changed because the old one was wrong in a way that mattered.
--
-- 0017 said the check stops "an importer that numbered every row 1, 2, 3 down
-- the file instead of within its own group" from landing a duplicate. Adversarial
-- review built that importer and ran it, and the duplicate landed:
--
--   Monday's file is [RENT]                  -> RENT gets occurrence 1
--   Tuesday's file is [MISC, RENT]           -> MISC gets 1, RENT gets 2
--
-- RENT at occurrence 2 has RENT at occurrence 1 sitting right behind it, put
-- there by Monday's import of the very row now being duplicated. There is no
-- gap. The check has nothing to object to, and the same transaction is in the
-- table twice.
--
-- Worse, that case is indistinguishable in principle from a legitimate one: a
-- statement really containing two identical rows produces exactly the same
-- INSERT. No trigger can tell them apart, because the difference is not in the
-- data — it is in whether the number was computed correctly. The only thing
-- standing between that bug and a duplicate is `withOccurrences` being right,
-- which is why it is a pure function with its own checks and its own mutation.
--
-- WHAT THIS CHECK DOES DO, and it is load-bearing:
--
-- It stops a hole. If a row could exist at occurrence 2 with no occurrence 1 —
-- from hand-written SQL, a restore of a partial export, a future importer that
-- numbers from something other than 1 — then the next correct import of that
-- same transaction computes occurrence 1, collides with nothing, and lands a
-- second copy. Contiguity is what makes "the number a correct importer would
-- compute" the same as "the number that is already taken".
--
-- The narrower claim is the true one, and it is the one worth keeping.

CREATE OR REPLACE FUNCTION check_occurrence_gapless() RETURNS trigger AS $$
BEGIN
  IF NEW.occurrence > 1 AND NOT EXISTS (
    SELECT 1 FROM bank_transaction b
     WHERE b.account_id  = NEW.account_id
       AND b.txn_date    = NEW.txn_date
       AND b.amount      = NEW.amount
       AND b.description = NEW.description
       AND b.occurrence  = NEW.occurrence - 1)
  THEN
    RAISE EXCEPTION 'OCCURRENCE_GAP: a bank row numbered % has no % before it (% on %)',
      NEW.occurrence, NEW.occurrence - 1, NEW.amount, NEW.txn_date;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
