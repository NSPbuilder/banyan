-- THE OVER-ALLOCATION RULE COUNTED THE ROW IT WAS ABOUT TO REPLACE.
--
-- `allocate` writes with INSERT … ON CONFLICT (claim_id, source_kind, source_id)
-- DO UPDATE, which is how the screen's "Change" button lowers a share. Postgres
-- fires the BEFORE INSERT trigger FIRST, on a proposed row carrying a fresh id,
-- and only then discovers the conflict and switches to the UPDATE. So
-- 0068's `id <> NEW.id` excluded nothing on that path: the existing row was
-- counted as somebody else's claim, and lowering a source already at 100% was
-- refused with SRED_OVER_ALLOCATED — a sentence saying the opposite of what the
-- person was doing.
--
-- Found by the mutation battery (2026-09-10): a block testing a different fence
-- came back red for THIS reason instead of its own, which is the failure the
-- battery exists to make visible rather than a curiosity about triggers.
--
-- The fix says the rule out loud instead of approximating it. What a claim may
-- take is 100 minus what the OTHER claims took, and `(claim_id, source_kind,
-- source_id)` is unique — so excluding this claim's own row excludes exactly the
-- row being replaced, on both paths, and nothing else.
CREATE OR REPLACE FUNCTION check_sred_allocation_total() RETURNS trigger AS $$
DECLARE taken numeric;
BEGIN
  SELECT COALESCE(SUM(percent), 0) INTO taken
    FROM sred_allocation
   WHERE source_kind = NEW.source_kind AND source_id = NEW.source_id
     AND claim_id <> NEW.claim_id;
  IF taken + NEW.percent > 100 THEN
    RAISE EXCEPTION 'SRED_OVER_ALLOCATED: % is already %%% claimed by other years or projects; % more would be over 100%%',
      NEW.source_kind, taken, NEW.percent
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
