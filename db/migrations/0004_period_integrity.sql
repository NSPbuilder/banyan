-- =============================================================================
-- 0004 — close two gaps a second critic review found.
--
-- 1. The closed-period control could be walked around without any special
--    privilege: an entry DATED inside a closed period was accepted as long as
--    its period_id pointed at some other, open period. The trigger checked the
--    status of whatever period it was handed and never checked that the date
--    belonged there — nor that the period belonged to the entry's ledger.
--    This is the control that protects filed GST/HST and T2 figures.
--
-- 2. check_balance_integrity only compared account-periods that appear in the
--    journal, so corruption invented in period_balance for a dormant
--    account-period went unseen — including equal-and-opposite shifts that net
--    out of the other checks.
-- =============================================================================

-- 1 -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_period_open() RETURNS trigger AS $$
DECLARE p RECORD;
BEGIN
  IF NEW.status <> 'posted' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'posted' THEN RETURN NEW; END IF;

  SELECT fp.status, fp.name, fp.ledger_id, fp.start_date, fp.end_date
    INTO p FROM fiscal_period fp WHERE fp.id = NEW.period_id;

  IF p IS NULL THEN
    RAISE EXCEPTION 'No fiscal period covers % in this ledger', NEW.entry_date;
  END IF;

  -- The period must belong to this entry's ledger.
  IF p.ledger_id <> NEW.ledger_id THEN
    RAISE EXCEPTION 'Period % belongs to a different ledger than entry %', p.name, NEW.id;
  END IF;

  -- The entry date must actually fall inside the period it is filed under.
  -- Without this, backdating into a closed period is a matter of picking a
  -- different period_id.
  IF NEW.entry_date < p.start_date OR NEW.entry_date > p.end_date THEN
    RAISE EXCEPTION 'Entry dated % cannot be filed under period % (% to %)',
      NEW.entry_date, p.name, p.start_date, p.end_date;
  END IF;

  IF p.status <> 'open' THEN
    RAISE EXCEPTION 'Fiscal period is % — cannot post entry dated %', p.status, NEW.entry_date;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 2 -------------------------------------------------------------------------
-- Now driven by period_balance itself: every stored row is compared with the
-- journal, so a row invented for an account that never moved is still checked.
CREATE OR REPLACE FUNCTION check_balance_integrity(p_ledger_id uuid)
RETURNS TABLE (
  check_name   text,
  account_code text,
  account_name text,
  period_name  text,
  expected     bigint,
  found        bigint
) AS $$
BEGIN
  -- (a) closing balance: cumulative journal total through the end of this period
  RETURN QUERY
  SELECT 'closing_balance'::text, a.code, a.name, fp.name, t.bal, pb.closing_balance
    FROM period_balance pb
    JOIN fiscal_period fp ON fp.id = pb.period_id
    JOIN account a ON a.id = pb.account_id
    CROSS JOIN LATERAL (
      SELECT COALESCE(SUM(jl.amount), 0)::bigint AS bal
        FROM journal_entry je
        JOIN journal_line jl ON jl.entry_id = je.id
        JOIN fiscal_period f2 ON f2.id = je.period_id
       WHERE je.ledger_id = p_ledger_id AND je.status IN ('posted','reversed')
         AND jl.account_id = pb.account_id AND f2.start_date <= fp.start_date
    ) t
   WHERE pb.ledger_id = p_ledger_id AND pb.closing_balance IS DISTINCT FROM t.bal;

  -- (a2) opening balance: cumulative journal total through the END of the
  --      previous period. Catches equal-and-opposite tampering that (b) nets out.
  RETURN QUERY
  SELECT 'opening_balance'::text, a.code, a.name, fp.name, t.bal, pb.opening_balance
    FROM period_balance pb
    JOIN fiscal_period fp ON fp.id = pb.period_id
    JOIN account a ON a.id = pb.account_id
    CROSS JOIN LATERAL (
      SELECT COALESCE(SUM(jl.amount), 0)::bigint AS bal
        FROM journal_entry je
        JOIN journal_line jl ON jl.entry_id = je.id
        JOIN fiscal_period f2 ON f2.id = je.period_id
       WHERE je.ledger_id = p_ledger_id AND je.status IN ('posted','reversed')
         AND jl.account_id = pb.account_id AND f2.start_date < fp.start_date
    ) t
   WHERE pb.ledger_id = p_ledger_id AND pb.opening_balance IS DISTINCT FROM t.bal;

  -- (a3) period movement: debits and credits recorded for the period itself
  RETURN QUERY
  SELECT 'period_movement'::text, a.code, a.name, fp.name,
         t.d - t.c, pb.period_debit - pb.period_credit
    FROM period_balance pb
    JOIN fiscal_period fp ON fp.id = pb.period_id
    JOIN account a ON a.id = pb.account_id
    CROSS JOIN LATERAL (
      SELECT COALESCE(SUM(jl.debit), 0)::bigint AS d, COALESCE(SUM(jl.credit), 0)::bigint AS c
        FROM journal_entry je
        JOIN journal_line jl ON jl.entry_id = je.id
       WHERE je.ledger_id = p_ledger_id AND je.status IN ('posted','reversed')
         AND jl.account_id = pb.account_id AND je.period_id = pb.period_id
    ) t
   WHERE pb.ledger_id = p_ledger_id
     AND (pb.period_debit IS DISTINCT FROM t.d OR pb.period_credit IS DISTINCT FROM t.c);

  -- (b) opening + movement = closing, on every row
  RETURN QUERY
  SELECT 'opening_plus_movement'::text, a.code, a.name, fp.name,
         (pb.opening_balance + pb.period_debit - pb.period_credit)::bigint, pb.closing_balance
    FROM period_balance pb
    JOIN account a ON a.id = pb.account_id
    JOIN fiscal_period fp ON fp.id = pb.period_id
   WHERE pb.ledger_id = p_ledger_id
     AND pb.closing_balance <> pb.opening_balance + pb.period_debit - pb.period_credit;

  -- (c) every period's closing balances sum to zero
  RETURN QUERY
  SELECT 'period_balances_to_zero'::text, ''::text, ''::text, fp.name,
         0::bigint, SUM(pb.closing_balance)::bigint
    FROM period_balance pb
    JOIN fiscal_period fp ON fp.id = pb.period_id
   WHERE pb.ledger_id = p_ledger_id
   GROUP BY fp.name
  HAVING SUM(pb.closing_balance) <> 0;

  -- (d) an account that has ever been posted to appears in every period
  RETURN QUERY
  SELECT 'account_missing_from_period'::text, a.code, a.name, fp.name, 0::bigint, 0::bigint
    FROM fiscal_period fp
    CROSS JOIN (SELECT DISTINCT jl.account_id FROM journal_entry je
                  JOIN journal_line jl ON jl.entry_id = je.id
                 WHERE je.ledger_id = p_ledger_id AND je.status IN ('posted','reversed')) u
    JOIN account a ON a.id = u.account_id
   WHERE fp.ledger_id = p_ledger_id
     AND NOT EXISTS (SELECT 1 FROM period_balance pb
                      WHERE pb.ledger_id = p_ledger_id AND pb.period_id = fp.id
                        AND pb.account_id = u.account_id);

  -- (e) an entry's date must sit inside the period it is filed under
  RETURN QUERY
  SELECT 'entry_outside_its_period'::text, je.entry_no, je.description, fp.name, 0::bigint, 0::bigint
    FROM journal_entry je JOIN fiscal_period fp ON fp.id = je.period_id
   WHERE je.ledger_id = p_ledger_id AND je.status IN ('posted','reversed')
     AND (je.entry_date < fp.start_date OR je.entry_date > fp.end_date);
END;
$$ LANGUAGE plpgsql;
