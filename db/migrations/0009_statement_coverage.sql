-- =============================================================================
-- 0009 — "has a role" is not the same as "appears on a statement".
--
-- check_untagged_accounts asked only whether an account carried ANY role. The
-- four cash-flow roles are carried by no statement line at all, so an account
-- tagged solely cf_operating passed the check while appearing on nothing. The
-- detector written to catch the quiet failure had the quiet failure in it.
--
-- CORRECTION to 0008's header comment, which is append-only and therefore
-- permanent: it says "every Tier-1 defect the kernel review found had the shape
-- of an ordinary administrative operation bypassing a control". docs/RISKS.md
-- retracts exactly that sentence. There are two shapes, and the second — a
-- check reporting success it did not earn — is the more common of the two, and
-- is what 0008's own detector turned out to be.
-- =============================================================================

DROP FUNCTION IF EXISTS check_untagged_accounts(uuid);

CREATE FUNCTION check_untagged_accounts(p_entity_id uuid)
RETURNS TABLE (
  code text, name text, account_type text, has_activity boolean, reason text
) AS $$
  SELECT a.code, a.name, a.account_type::text,
         EXISTS (SELECT 1 FROM journal_line jl WHERE jl.account_id = a.id),
         CASE
           WHEN NOT EXISTS (SELECT 1 FROM account_role ar WHERE ar.account_id = a.id)
             THEN 'no role'
           ELSE 'carries only roles that no statement uses'
         END
    FROM account a
   WHERE a.entity_id = p_entity_id
     AND a.is_postable
     AND a.is_active
     -- The test is reaching a statement line, not merely holding a role.
     AND NOT EXISTS (
       SELECT 1 FROM account_role ar
        WHERE ar.account_id = a.id
          AND EXISTS (SELECT 1 FROM statement_line sl WHERE ar.role = ANY (sl.roles)))
   ORDER BY a.code;
$$ LANGUAGE sql STABLE;

-- The mirror image: a statement line whose roles no account carries renders as
-- zero and says nothing. Harmless on a line the company genuinely has nothing
-- for, worth seeing on one it does.
CREATE OR REPLACE FUNCTION check_unused_statement_lines(p_entity_id uuid, p_template text)
RETURNS TABLE (line_code text, label text, roles text[]) AS $$
  SELECT sl.code, sl.label, sl.roles
    FROM statement_line sl
    JOIN statement_template st ON st.id = sl.template_id
   WHERE st.code = p_template
     AND sl.line_type = 'detail'
     AND cardinality(sl.roles) > 0
     AND NOT EXISTS (
       SELECT 1 FROM account_role ar JOIN account a ON a.id = ar.account_id
        WHERE a.entity_id = p_entity_id AND a.is_active AND ar.role = ANY (sl.roles))
   ORDER BY sl.sort_order;
$$ LANGUAGE sql STABLE;
