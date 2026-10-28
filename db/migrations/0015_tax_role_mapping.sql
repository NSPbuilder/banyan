-- 0015 — one role, two taxes
--
-- 0014 decided which registration an entry needed by reading the role name:
-- 'gst%' meant GST/HST, anything else meant QST. But the seeded taxonomy has a
-- SINGLE role for both provincial taxes — `qst_pst_payable` — because a chart
-- of accounts does not care which province wrote the rules.
--
-- So `LIKE 'qst%'` was true for a Manitoba company's PST too, and the check
-- went looking for a QST registration it would never find. Every PST entry in
-- BC, SK and MB would have been reported as "tax outside the registered
-- period" — a loud false alarm on correct books, which teaches the owner to
-- ignore the check.
--
-- A provincial role is now satisfied by a registration for EITHER provincial
-- tax, since no company registers for both.

CREATE OR REPLACE FUNCTION check_tax_outside_registration(p_ledger_id uuid)
RETURNS TABLE (entry_no text, entry_date date, description text, tax text, amount bigint) AS $$
  SELECT je.entry_no, je.entry_date, je.description,
         CASE WHEN ar.role LIKE 'gst%' THEN 'GST_HST' ELSE 'QST/PST' END,
         SUM(jl.amount)::bigint
    FROM journal_entry je
    JOIN journal_line jl ON jl.entry_id = je.id
    JOIN account a ON a.id = jl.account_id
    JOIN account_role ar ON ar.account_id = a.id
    JOIN ledger l ON l.id = je.ledger_id
   WHERE je.ledger_id = p_ledger_id
     AND je.status IN ('posted','reversed')
     AND ar.role IN ('gst_hst_payable', 'gst_hst_recoverable',
                     'qst_pst_payable', 'qst_pst_recoverable')
     AND NOT EXISTS (
       SELECT 1 FROM entity_tax_registration r
        WHERE r.entity_id = l.entity_id
          AND r.tax = ANY (CASE WHEN ar.role LIKE 'gst%' THEN ARRAY['GST_HST']
                                ELSE ARRAY['QST','PST'] END)
          AND je.entry_date >= r.registered_on
          AND (r.ceased_on IS NULL OR je.entry_date <= r.ceased_on))
   GROUP BY je.entry_no, je.entry_date, je.description, ar.role
  HAVING SUM(jl.amount) <> 0
   ORDER BY je.entry_date;
$$ LANGUAGE sql STABLE;
