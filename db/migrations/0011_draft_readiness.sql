-- =============================================================================
-- 0011 — check_stale_drafts asked the wrong question.
--
-- It asked whether a draft was unbalanced, uncovered by a period, or old. What
-- matters is whether it CAN POST. Two drafts that can never post were invisible
-- to it:
--
--   * a draft naming an account that was deactivated after it was saved —
--     refused at posting with INACTIVE_ACCOUNT, reported by nothing
--   * a draft with fewer than two lines, which the screen creates by pressing
--     Save draft on a blank form — refused forever with TOO_FEW_LINES, and
--     silent here because zero lines sum to zero
--
-- docs/RISKS.md claimed the detector covered the first of those. It did not.
-- This is the second of the two recorded patterns again: a check that reports
-- success it did not earn.
-- =============================================================================

DROP FUNCTION IF EXISTS check_stale_drafts(uuid, int);

CREATE FUNCTION check_stale_drafts(p_ledger_id uuid, p_days int DEFAULT 30)
RETURNS TABLE (
  id text, entry_date date, description text,
  net_cents bigint, line_count int, age_days int, reason text
) AS $$
  WITH d AS (
    SELECT je.id, je.entry_date, je.description, je.created_at, je.ledger_id,
           COALESCE(SUM(jl.amount), 0)::bigint AS net,
           count(jl.id)::int                   AS lines,
           EXTRACT(DAY FROM now() - je.created_at)::int AS age,
           -- an account that would be refused at posting
           EXISTS (
             SELECT 1 FROM journal_line l
               JOIN account a ON a.id = l.account_id
               JOIN ledger lg ON lg.id = je.ledger_id
              WHERE l.entry_id = je.id
                AND (NOT a.is_active OR NOT a.is_postable OR a.entity_id <> lg.entity_id)
           ) AS bad_account,
           EXISTS (SELECT 1 FROM fiscal_period fp
                    WHERE fp.ledger_id = je.ledger_id
                      AND je.entry_date BETWEEN fp.start_date AND fp.end_date) AS covered,
           EXISTS (SELECT 1 FROM fiscal_period fp
                    WHERE fp.ledger_id = je.ledger_id
                      AND je.entry_date BETWEEN fp.start_date AND fp.end_date
                      AND fp.status = 'open') AS postable_period
      FROM journal_entry je
      LEFT JOIN journal_line jl ON jl.entry_id = je.id
     WHERE je.ledger_id = p_ledger_id AND je.status = 'draft'
     GROUP BY je.id, je.entry_date, je.description, je.created_at, je.ledger_id
  )
  SELECT d.id::text, d.entry_date, d.description, d.net, d.lines, d.age,
         CASE
           WHEN d.lines < 2            THEN 'needs at least two lines'
           WHEN d.net <> 0             THEN 'does not balance'
           WHEN d.bad_account          THEN 'names an account that can no longer be posted to'
           WHEN NOT d.covered          THEN 'no fiscal period covers its date'
           WHEN NOT d.postable_period  THEN 'its period has closed since it was saved'
           ELSE 'older than ' || p_days || ' days'
         END
    FROM d
   WHERE d.lines < 2 OR d.net <> 0 OR d.bad_account
      OR NOT d.covered OR NOT d.postable_period OR d.age > p_days
   ORDER BY d.entry_date;
$$ LANGUAGE sql STABLE;
