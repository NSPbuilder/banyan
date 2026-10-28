-- =============================================================================
-- 0003 — close the gaps a critic review found in the P0 kernel.
--
-- 1. journal_entry.total_debit / total_credit were never compared to the lines.
--    A posted entry could carry balanced lines and a header saying anything at
--    all — and the header is what an entry screen displays.
-- 2. Closing or reopening a fiscal period left no audit trail, though it is the
--    control that protects filed GST/HST and T2 figures.
-- 3. Nothing checked that period_balance still agrees with the ledger.
-- =============================================================================

-- 1 -------------------------------------------------------------------------
-- Extend the deferred balance check so the header totals must equal the lines.
CREATE OR REPLACE FUNCTION assert_entry_balanced_on_header() RETURNS trigger AS $$
DECLARE v_sum bigint; v_debit bigint; v_credit bigint;
BEGIN
  IF NEW.status = 'draft' THEN RETURN NULL; END IF;

  SELECT COALESCE(SUM(amount), 0), COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0)
    INTO v_sum, v_debit, v_credit
    FROM journal_line WHERE entry_id = NEW.id;

  IF NOT EXISTS (SELECT 1 FROM journal_line WHERE entry_id = NEW.id) THEN
    RAISE EXCEPTION 'Journal entry % has no lines', NEW.id;
  END IF;
  IF v_sum <> 0 THEN
    RAISE EXCEPTION 'Journal entry % is out of balance by % cents', NEW.id, v_sum;
  END IF;
  IF NEW.total_debit <> v_debit OR NEW.total_credit <> v_credit THEN
    RAISE EXCEPTION
      'Journal entry % header says debit %/credit % but its lines total debit %/credit %',
      NEW.id, NEW.total_debit, NEW.total_credit, v_debit, v_credit;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- The line-level trigger must apply the same rule, otherwise lines could be
-- added after the header was accepted.
CREATE OR REPLACE FUNCTION assert_entry_balanced() RETURNS trigger AS $$
DECLARE
  v_id uuid; v_status text;
  v_sum bigint; v_debit bigint; v_credit bigint;
  v_hdr_debit bigint; v_hdr_credit bigint;
BEGIN
  v_id := COALESCE(NEW.entry_id, OLD.entry_id);
  SELECT status, total_debit, total_credit
    INTO v_status, v_hdr_debit, v_hdr_credit
    FROM journal_entry WHERE id = v_id;

  IF v_status IS NULL OR v_status = 'draft' THEN
    RETURN NULL;                                   -- drafts may be lopsided
  END IF;

  SELECT COALESCE(SUM(amount), 0), COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0)
    INTO v_sum, v_debit, v_credit
    FROM journal_line WHERE entry_id = v_id;

  IF v_sum <> 0 THEN
    RAISE EXCEPTION 'Journal entry % is out of balance by % cents', v_id, v_sum;
  END IF;
  IF v_hdr_debit <> v_debit OR v_hdr_credit <> v_credit THEN
    RAISE EXCEPTION
      'Journal entry % header says debit %/credit % but its lines total debit %/credit %',
      v_id, v_hdr_debit, v_hdr_credit, v_debit, v_credit;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- 2 -------------------------------------------------------------------------
-- Opening or closing a period is a control action. Record it in the database,
-- so it is captured however the change was made.
CREATE OR REPLACE FUNCTION log_period_status_change() RETURNS trigger AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO audit_log (actor, action, table_name, record_id, before, after, context)
    VALUES (COALESCE(NEW.closed_by, current_user),
            CASE WHEN NEW.status = 'open' THEN 'reopen_period' ELSE 'close_period' END,
            TG_TABLE_NAME, NEW.id::text,
            jsonb_build_object('status', OLD.status),
            jsonb_build_object('status', NEW.status),
            jsonb_build_object('name', NEW.name, 'ledger_id', NEW.ledger_id));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_period_status_audit
  AFTER UPDATE ON fiscal_period
  FOR EACH ROW EXECUTE FUNCTION log_period_status_change();

CREATE OR REPLACE FUNCTION log_year_status_change() RETURNS trigger AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO audit_log (actor, action, table_name, record_id, before, after, context)
    VALUES (current_user,
            CASE WHEN NEW.status = 'open' THEN 'reopen_year' ELSE 'close_year' END,
            TG_TABLE_NAME, NEW.id::text,
            jsonb_build_object('status', OLD.status),
            jsonb_build_object('status', NEW.status),
            jsonb_build_object('name', NEW.name, 'ledger_id', NEW.ledger_id));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_year_status_audit
  AFTER UPDATE ON fiscal_year
  FOR EACH ROW EXECUTE FUNCTION log_year_status_change();

-- 3 -------------------------------------------------------------------------
-- Read-only integrity check. period_balance is a cache; this compares it with
-- the ledger it is supposed to summarise and returns only the disagreements.
-- Empty result = the cache is trustworthy. Changes nothing.
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
  -- (a) closing balance per account per period vs. the ledger itself
  RETURN QUERY
  WITH truth AS (
    SELECT jl.account_id, fp.id AS period_id, fp.start_date,
           SUM(SUM(jl.amount)) OVER (PARTITION BY jl.account_id ORDER BY fp.start_date)::bigint AS bal
      FROM journal_entry je
      JOIN journal_line jl ON jl.entry_id = je.id
      JOIN fiscal_period fp ON fp.id = je.period_id
     WHERE je.ledger_id = p_ledger_id AND je.status IN ('posted','reversed')
     GROUP BY jl.account_id, fp.id, fp.start_date
  )
  SELECT 'closing_balance'::text, a.code, a.name, fp.name, t.bal, pb.closing_balance
    FROM truth t
    JOIN period_balance pb ON pb.account_id = t.account_id AND pb.period_id = t.period_id
                          AND pb.ledger_id = p_ledger_id
    JOIN account a ON a.id = t.account_id
    JOIN fiscal_period fp ON fp.id = t.period_id
   WHERE pb.closing_balance IS DISTINCT FROM t.bal;

  -- (b) opening + movement must equal closing on every row
  RETURN QUERY
  SELECT 'opening_plus_movement'::text, a.code, a.name, fp.name,
         (pb.opening_balance + pb.period_debit - pb.period_credit)::bigint, pb.closing_balance
    FROM period_balance pb
    JOIN account a ON a.id = pb.account_id
    JOIN fiscal_period fp ON fp.id = pb.period_id
   WHERE pb.ledger_id = p_ledger_id
     AND pb.closing_balance <> pb.opening_balance + pb.period_debit - pb.period_credit;

  -- (c) every period's closing balances must sum to zero
  RETURN QUERY
  SELECT 'period_balances_to_zero'::text, ''::text, ''::text, fp.name, 0::bigint, SUM(pb.closing_balance)::bigint
    FROM period_balance pb
    JOIN fiscal_period fp ON fp.id = pb.period_id
   WHERE pb.ledger_id = p_ledger_id
   GROUP BY fp.name
  HAVING SUM(pb.closing_balance) <> 0;

  -- (d) an account that has ever been posted to must appear in every period
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
END;
$$ LANGUAGE plpgsql;
