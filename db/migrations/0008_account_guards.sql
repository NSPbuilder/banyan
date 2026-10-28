-- =============================================================================
-- 0008 — the chart of accounts is about to become editable from a screen.
--
-- RISKS.md records the pattern behind every Tier-1 defect the kernel review
-- found: an operation that looks like ordinary administration turns out to
-- bypass a control. Editing an account is exactly that shape. An account's TYPE
-- decides which half of which statement it appears in; changing it after the
-- account has been posted to silently rewrites every report already filed.
-- Moving an account to another company silently moves money between two sets of
-- books. Neither looks like an attack.
-- =============================================================================

-- 1 -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION guard_account_mutation() RETURNS trigger AS $$
DECLARE v_lines bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT count(*) INTO v_lines FROM journal_line WHERE account_id = OLD.id;
    IF v_lines > 0 THEN
      RAISE EXCEPTION 'Account % % has % journal line%; it cannot be deleted. Deactivate it instead.',
        OLD.code, OLD.name, v_lines, CASE WHEN v_lines = 1 THEN '' ELSE 's' END;
    END IF;
    RETURN OLD;
  END IF;

  -- An account belongs to one company for its whole life. There is no
  -- legitimate reason to move one, and every illegitimate one moves money.
  IF NEW.entity_id IS DISTINCT FROM OLD.entity_id THEN
    RAISE EXCEPTION 'Account % cannot be moved to another company', OLD.code;
  END IF;

  IF  NEW.account_type   IS NOT DISTINCT FROM OLD.account_type
  AND NEW.normal_balance IS NOT DISTINCT FROM OLD.normal_balance THEN
    RETURN NEW;                                   -- name, code, flags may change
  END IF;

  SELECT count(*) INTO v_lines
    FROM journal_line jl JOIN journal_entry je ON je.id = jl.entry_id
   WHERE jl.account_id = OLD.id AND je.status IN ('posted','reversed');

  IF v_lines > 0 THEN
    RAISE EXCEPTION
      'Account % % has been posted to % time%; its type cannot change. Create a new account instead.',
      OLD.code, OLD.name, v_lines, CASE WHEN v_lines = 1 THEN '' ELSE 's' END;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_account_mutation
  BEFORE UPDATE OR DELETE ON account
  FOR EACH ROW EXECUTE FUNCTION guard_account_mutation();

-- 2 -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION log_account_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO audit_log (actor, action, table_name, record_id, after, context)
    VALUES (current_user, 'create_account', 'account', NEW.id::text,
            jsonb_build_object('code', NEW.code, 'name', NEW.name,
                               'type', NEW.account_type, 'normal_balance', NEW.normal_balance),
            jsonb_build_object('entity_id', NEW.entity_id));
    RETURN NEW;
  END IF;

  IF  NEW.code           IS DISTINCT FROM OLD.code
   OR NEW.name           IS DISTINCT FROM OLD.name
   OR NEW.account_type   IS DISTINCT FROM OLD.account_type
   OR NEW.normal_balance IS DISTINCT FROM OLD.normal_balance
   OR NEW.is_postable    IS DISTINCT FROM OLD.is_postable
   OR NEW.is_active      IS DISTINCT FROM OLD.is_active
   OR NEW.parent_id      IS DISTINCT FROM OLD.parent_id THEN
    INSERT INTO audit_log (actor, action, table_name, record_id, before, after)
    VALUES (current_user, 'update_account', 'account', NEW.id::text,
            jsonb_build_object('code', OLD.code, 'name', OLD.name, 'type', OLD.account_type,
                               'normal_balance', OLD.normal_balance, 'is_postable', OLD.is_postable,
                               'is_active', OLD.is_active, 'parent_id', OLD.parent_id),
            jsonb_build_object('code', NEW.code, 'name', NEW.name, 'type', NEW.account_type,
                               'normal_balance', NEW.normal_balance, 'is_postable', NEW.is_postable,
                               'is_active', NEW.is_active, 'parent_id', NEW.parent_id));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_account_audit
  AFTER INSERT OR UPDATE ON account
  FOR EACH ROW EXECUTE FUNCTION log_account_change();

-- 3 -------------------------------------------------------------------------
-- A role's category must match the account's type, and an account carries at
-- most one role per family.
--
-- This is what stops a chart from producing a balanced-but-wrong statement:
-- tagging a liability account with an asset role moves the figure to the other
-- side of the balance sheet, and the sheet still balances, because the roles
-- are only ever summed.
CREATE OR REPLACE FUNCTION guard_account_role() RETURNS trigger AS $$
DECLARE r RECORD; a RECORD; v_existing text;
BEGIN
  SELECT code, label, category, family INTO r FROM role_definition WHERE code = NEW.role;
  SELECT code, name, account_type INTO a FROM account WHERE id = NEW.account_id;

  IF r.category IS NOT NULL AND r.category <> a.account_type THEN
    RAISE EXCEPTION 'Role "%" is for % accounts; % % is %',
      r.label, r.category, a.code, a.name, a.account_type;
  END IF;

  SELECT rd.label INTO v_existing
    FROM account_role ar JOIN role_definition rd ON rd.code = ar.role
   WHERE ar.account_id = NEW.account_id AND rd.family = r.family AND ar.role <> NEW.role
   LIMIT 1;

  IF v_existing IS NOT NULL THEN
    RAISE EXCEPTION 'Account % % already carries the % role "%"; an account takes at most one per family',
      a.code, a.name, r.family, v_existing;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_account_role_consistent
  BEFORE INSERT OR UPDATE ON account_role
  FOR EACH ROW EXECUTE FUNCTION guard_account_role();

-- 4 -------------------------------------------------------------------------
-- An account carrying no role appears on no statement. The trial balance still
-- balances and the balance sheet still balances, because a figure that is in no
-- statement line is simply absent from both sides. Nothing errors; the reports
-- are just quietly incomplete. This reports them so a screen can say so.
CREATE OR REPLACE FUNCTION check_untagged_accounts(p_entity_id uuid)
RETURNS TABLE (code text, name text, account_type text, has_activity boolean) AS $$
  SELECT a.code, a.name, a.account_type::text,
         EXISTS (SELECT 1 FROM journal_line jl WHERE jl.account_id = a.id)
    FROM account a
   WHERE a.entity_id = p_entity_id
     AND a.is_postable
     AND a.is_active
     AND NOT EXISTS (SELECT 1 FROM account_role ar WHERE ar.account_id = a.id)
   ORDER BY a.code;
$$ LANGUAGE sql STABLE;
