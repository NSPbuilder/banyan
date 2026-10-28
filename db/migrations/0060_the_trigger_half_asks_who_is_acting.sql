-- 0060 — the trigger half of the audit trail names the person, not the role.
--
-- Twelve trigger functions (fifteen INSERTs) write `current_user` as the actor —
-- discarding a draft, renaming an account, closing a year, un-applying money
-- from an invoice, putting a bank row back in play. A trigger cannot see who
-- the application thinks is acting, so every one of those rows has named the
-- Postgres role, "alicio", whoever was signed in. RISKS §10 carried it while
-- one person used this; 0053 and 0054 made a second person possible, and a
-- trail in which two people are one name is not a trail.
--
-- The fix is not twelve rewritten functions. The application says who is
-- acting ONCE per transaction — `set_config('app.actor', email, true)`, local
-- to the transaction, the same mechanism 0038 uses for `erp.open_edit` — and
-- ONE trigger at the door of audit_log substitutes it wherever a row arrived
-- carrying the role's name. A row that already names somebody is left alone:
-- `COALESCE(NEW.closed_by, current_user)` still wins when closed_by is set,
-- and 'system' is still 'system'.
--
-- Substituting only when the actor IS the role (not unconditionally) is the
-- point: an application row that names a person must not be overwritten by a
-- stale setting, and the setting is transaction-local so there is no stale
-- setting to have. When no setting is present — psql, a hand-written UPDATE —
-- the role's name stands, which is the truth in that case.
--
-- `src/lib/acting.ts` is the application half; `docs/design/17-users-and-access.md`
-- says why here and not in each function.

CREATE OR REPLACE FUNCTION audit_actor_from_setting() RETURNS trigger AS $$
BEGIN
  IF NEW.actor = current_user::text THEN
    NEW.actor := coalesce(nullif(current_setting('app.actor', true), ''), NEW.actor);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_actor
  BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_actor_from_setting();
