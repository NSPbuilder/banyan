-- 0027 — the role's KIND is part of the rule too, and two corrections to 0026
--
-- Why: docs/design/03-parties.md, 「它得一直成立，不是变成成立」.
--
-- 0026 was already applied when adversarial review found a fifth way to break
-- the party rule, and two things wrong with what 0026 says about itself.
-- Migrations are append-only under a checksum, so the correction goes here.
-- 0018 and 0024 did the same.
--
-- CORRECTION 1 — 0026's header says 「Why: docs/design/03-parties.md,
-- 「Built on 2026-08-27」 and the note under it about what 0026 closed」. No such
-- note existed when that line was written; the section describing 0026 is
-- 「它得一直成立，不是变成成立」 and was added afterwards. Cite by section title,
-- not by a note you intend to write.
--
-- CORRECTION 2 — 0026 says the invariant is 「maintained on every path that can
-- break it」. That is a claim about paths nobody has thought of. Four were found
-- then; this file is the fifth. The honest form is the enumeration, and the
-- enumeration now lives in `03`.
--
-- THE FIFTH PATH — `party_may_transact` gates on
-- `party_role_definition.transacts`. Setting 'supplier' to false orphans every
-- supplier-explained line in every company at once, and none of 0026's triggers
-- watch that table: the reference table looked like seed data rather than like
-- part of the rule. The other four guards are about a party or an entry; this
-- one is about the vocabulary they are written in, which is why it was last.

-- -----------------------------------------------------------------------------
-- 4. Whether a role transacts is part of the rule, so it is held to it too.
--
-- `party_may_transact` gates on `party_role_definition.transacts`. Flipping
-- 'supplier' to false orphans every supplier-explained line at once, and none
-- of the triggers above watch that table — the reference table looked like
-- static seed data rather than like part of the rule.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_role_kind_still_covers() RETURNS trigger AS $$
DECLARE
  n bigint;
BEGIN
  IF NEW.transacts OR NOT OLD.transacts THEN RETURN NULL; END IF;

  SELECT count(*) INTO n
    FROM journal_line jl
    JOIN journal_entry e ON e.id = jl.entry_id
    JOIN ledger l ON l.id = e.ledger_id
   WHERE jl.party_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM party_role pr
                  WHERE pr.party_id = jl.party_id AND pr.entity_id = l.entity_id
                    AND pr.role = OLD.code
                    AND e.entry_date BETWEEN pr.held_from
                                         AND COALESCE(pr.held_to, 'infinity'::date))
     AND NOT party_may_transact(jl.party_id, l.entity_id, e.entry_date);

  IF n > 0 THEN
    RAISE EXCEPTION 'ROLE_KIND_STILL_NEEDED: % journal line% explained by the % role; it cannot stop being one that trades',
      n, CASE WHEN n = 1 THEN ' is' ELSE 's are' END, OLD.code;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_role_kind_still_covers
  AFTER UPDATE ON party_role_definition
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_role_kind_still_covers();
