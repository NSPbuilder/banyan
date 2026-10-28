-- AND THE ROW THAT CHANGES HANDS.
--
-- 0069 excluded `claim_id <> NEW.claim_id`, which is right for every write this
-- application makes — `allocate` and `unallocate` never move a row between
-- claims — and its header said "on both paths, and nothing else". There is a
-- third path, and on it the sentence was false: an UPDATE that CHANGES
-- `claim_id` leaves the pre-image row carrying the old claim, so the exclusion
-- does not reach it, its own percent is summed into `taken`, and the row is
-- counted against itself. 0068's `id <> NEW.id` did exclude that one
-- (independent critic, 2026-09-11).
--
-- The consequence was bounded and in the safe direction — a spurious refusal,
-- never a permitted over-allocation — and nothing in the tree writes that way
-- today. It is fixed rather than documented because the alternative was to
-- weaken the sentence, and a fence whose description has to be narrowed to stay
-- true is a fence somebody will lean on at the wrong angle later.
--
-- Both exclusions, and they do not overlap wastefully:
--   INSERT … ON CONFLICT DO UPDATE — NEW.id is a fresh uuid, so `id <> NEW.id`
--     excludes nothing and `claim_id <> NEW.claim_id` excludes the row about to
--     be replaced, which the unique index guarantees is exactly one;
--   UPDATE keeping claim_id — either clause excludes the row itself;
--   UPDATE changing claim_id — `id <> NEW.id` excludes it, and the other
--     claims' rows are still counted, which is the rule.
CREATE OR REPLACE FUNCTION check_sred_allocation_total() RETURNS trigger AS $$
DECLARE taken numeric;
BEGIN
  SELECT COALESCE(SUM(percent), 0) INTO taken
    FROM sred_allocation
   WHERE source_kind = NEW.source_kind AND source_id = NEW.source_id
     AND id <> NEW.id
     AND claim_id <> NEW.claim_id;
  IF taken + NEW.percent > 100 THEN
    RAISE EXCEPTION 'SRED_OVER_ALLOCATED: % is already %%% claimed by other years or projects; % more would be over 100%%',
      NEW.source_kind, taken, NEW.percent
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
