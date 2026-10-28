-- 0075: an account carrying only cash-flow roles is reached by a statement.
--
-- check_untagged_accounts (0009) asks whether an account's roles reach a
-- statement_line. The cash flow statement is derived, not templated — it has
-- no statement_line rows — so an account tagged only cf_operating, cf_investing,
-- cf_financing or cf_non_cash_adjustment was reported as carrying "roles that
-- no statement uses". That was true when RISKS §8 was written and the cash
-- flow statement did not exist; it has existed since the two derived
-- statements landed, and those four roles are exactly what drives its sections.
--
-- The account is still worth reporting: its roles reach the cash flow and
-- nothing else, so no balance sheet or income statement line carries it. The
-- reason now says that, instead of a sentence that is no longer true.
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
           WHEN EXISTS (SELECT 1 FROM account_role ar WHERE ar.account_id = a.id
                         AND ar.role IN ('cf_operating', 'cf_investing', 'cf_financing', 'cf_non_cash_adjustment'))
             THEN 'reaches only the cash flow statement — no balance sheet or income statement line carries it'
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
