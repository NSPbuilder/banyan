-- =============================================================================
-- 0007 — a closed period must also stay the same period.
--
-- 0006 stopped two periods from overlapping, but left their boundaries freely
-- editable. Two ordinary UPDATEs still walked past every guard: shrink closed
-- January to end on the 19th, extend open February to start on the 20th. No
-- overlap exists at any instant, so the EXCLUDE constraint never fires — and
-- $77,777 dated 20 January posts into "February" with both integrity checks
-- silent. The same mutability defeated 0006's locked-year check: reassigning a
-- period's fiscal_year_id to an open year made the year status irrelevant.
--
-- Editing a period's dates is ordinary administration, exactly as creating one
-- was. Neither change was audited: log_period_status_change fires only on a
-- status change, so reopening January was recorded but silently redefining
-- what January MEANS was not.
--
-- CORRECTION to 0006's header comment, which is append-only and therefore
-- permanent: it states the overlapping-period counterexample left "both
-- integrity checks silent". That is true only AFTER rebuild_period_balances
-- runs. Through the ordinary posting path the new period has no period_balance
-- rows, so check_balance_integrity immediately reports account_missing_from_period
-- for every account. It is the rebuild — which the ledger page offers as a
-- button — that makes it quiet.
-- =============================================================================

-- 1 -------------------------------------------------------------------------
-- Boundaries may only move while the period is open AND holds nothing.
CREATE OR REPLACE FUNCTION guard_period_redefinition() RETURNS trigger AS $$
DECLARE v_entries bigint; v_fy RECORD;
BEGIN
  IF  NEW.start_date     IS NOT DISTINCT FROM OLD.start_date
  AND NEW.end_date       IS NOT DISTINCT FROM OLD.end_date
  AND NEW.fiscal_year_id IS NOT DISTINCT FROM OLD.fiscal_year_id
  AND NEW.ledger_id      IS NOT DISTINCT FROM OLD.ledger_id THEN
    RETURN NEW;                                  -- nothing structural changed
  END IF;

  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'Period % is %; its dates cannot be changed. Reopen it first.',
      OLD.name, OLD.status;
  END IF;

  SELECT count(*) INTO v_entries FROM journal_entry
   WHERE period_id = OLD.id AND status IN ('posted','reversed');
  IF v_entries > 0 THEN
    RAISE EXCEPTION 'Period % holds % posted entr%; its dates cannot be changed.',
      OLD.name, v_entries, CASE WHEN v_entries = 1 THEN 'y' ELSE 'ies' END;
  END IF;

  -- A period belongs to one year, in one ledger, and sits inside that year.
  SELECT fy.ledger_id, fy.start_date, fy.end_date, fy.name, fy.status
    INTO v_fy FROM fiscal_year fy WHERE fy.id = NEW.fiscal_year_id;
  IF v_fy IS NULL THEN
    RAISE EXCEPTION 'Fiscal year % does not exist', NEW.fiscal_year_id;
  END IF;
  IF v_fy.ledger_id <> NEW.ledger_id THEN
    RAISE EXCEPTION 'Fiscal year % belongs to a different ledger than period %', v_fy.name, NEW.name;
  END IF;
  IF NEW.start_date < v_fy.start_date OR NEW.end_date > v_fy.end_date THEN
    RAISE EXCEPTION 'Period % (% to %) does not sit inside fiscal year % (% to %)',
      NEW.name, NEW.start_date, NEW.end_date, v_fy.name, v_fy.start_date, v_fy.end_date;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_period_redefinition
  BEFORE UPDATE ON fiscal_period
  FOR EACH ROW EXECUTE FUNCTION guard_period_redefinition();

-- 2 -------------------------------------------------------------------------
-- Whatever survives the guard is recorded. Redefining a period is at least as
-- consequential as closing one, and only the latter was audited.
CREATE OR REPLACE FUNCTION log_period_redefinition() RETURNS trigger AS $$
BEGIN
  IF  NEW.start_date     IS DISTINCT FROM OLD.start_date
   OR NEW.end_date       IS DISTINCT FROM OLD.end_date
   OR NEW.fiscal_year_id IS DISTINCT FROM OLD.fiscal_year_id
   OR NEW.ledger_id      IS DISTINCT FROM OLD.ledger_id THEN
    INSERT INTO audit_log (actor, action, table_name, record_id, before, after, context)
    VALUES (current_user, 'redefine_period', TG_TABLE_NAME, NEW.id::text,
            jsonb_build_object('start_date', OLD.start_date, 'end_date', OLD.end_date,
                               'fiscal_year_id', OLD.fiscal_year_id, 'ledger_id', OLD.ledger_id),
            jsonb_build_object('start_date', NEW.start_date, 'end_date', NEW.end_date,
                               'fiscal_year_id', NEW.fiscal_year_id, 'ledger_id', NEW.ledger_id),
            jsonb_build_object('name', NEW.name));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_period_redefinition_audit
  AFTER UPDATE ON fiscal_period
  FOR EACH ROW EXECUTE FUNCTION log_period_redefinition();

-- 3 -------------------------------------------------------------------------
-- The same argument for the year itself: its dates bound every period inside it.
CREATE OR REPLACE FUNCTION guard_year_redefinition() RETURNS trigger AS $$
DECLARE v_entries bigint;
BEGIN
  IF  NEW.start_date IS NOT DISTINCT FROM OLD.start_date
  AND NEW.end_date   IS NOT DISTINCT FROM OLD.end_date
  AND NEW.ledger_id  IS NOT DISTINCT FROM OLD.ledger_id THEN
    RETURN NEW;
  END IF;

  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'Fiscal year % is %; its dates cannot be changed.', OLD.name, OLD.status;
  END IF;

  SELECT count(*) INTO v_entries
    FROM journal_entry je JOIN fiscal_period fp ON fp.id = je.period_id
   WHERE fp.fiscal_year_id = OLD.id AND je.status IN ('posted','reversed');
  IF v_entries > 0 THEN
    RAISE EXCEPTION 'Fiscal year % holds % posted entr%; its dates cannot be changed.',
      OLD.name, v_entries, CASE WHEN v_entries = 1 THEN 'y' ELSE 'ies' END;
  END IF;

  INSERT INTO audit_log (actor, action, table_name, record_id, before, after, context)
  VALUES (current_user, 'redefine_year', TG_TABLE_NAME, NEW.id::text,
          jsonb_build_object('start_date', OLD.start_date, 'end_date', OLD.end_date),
          jsonb_build_object('start_date', NEW.start_date, 'end_date', NEW.end_date),
          jsonb_build_object('name', NEW.name));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_year_redefinition
  BEFORE UPDATE ON fiscal_year
  FOR EACH ROW EXECUTE FUNCTION guard_year_redefinition();

-- 4 -------------------------------------------------------------------------
-- Report any entry whose date is not covered by the period it is filed under,
-- or which sits in a period belonging to a different ledger. This is the
-- after-the-fact detector for anything that ever got past the guards above.
CREATE OR REPLACE FUNCTION check_period_assignments(p_ledger_id uuid)
RETURNS TABLE (entry_no text, entry_date date, period_name text, reason text) AS $$
  SELECT je.entry_no, je.entry_date, fp.name,
         CASE WHEN fp.ledger_id <> je.ledger_id THEN 'period belongs to another ledger'
              WHEN je.entry_date < fp.start_date THEN 'entry dated before its period'
              ELSE 'entry dated after its period' END
    FROM journal_entry je JOIN fiscal_period fp ON fp.id = je.period_id
   WHERE je.ledger_id = p_ledger_id AND je.status IN ('posted','reversed')
     AND (fp.ledger_id <> je.ledger_id
          OR je.entry_date < fp.start_date OR je.entry_date > fp.end_date);
$$ LANGUAGE sql STABLE;
