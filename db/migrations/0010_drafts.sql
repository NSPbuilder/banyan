-- =============================================================================
-- 0010 — drafts.
--
-- A draft is the first mutable thing the ledger has held. Every Tier-1 the
-- kernel review found came from mutable state that looked harmless, so the
-- guards go in before the feature.
--
-- Three specific holes a draft opens:
--
--   1. journal_line's account/entity check runs on INSERT only. If a draft's
--      ledger_id could change afterwards, its lines would point at another
--      company's accounts and nothing would look again.
--   2. A draft carrying a period_id would let a period close between saving and
--      posting, and posting would then use the stale period — an entry dated
--      inside a closed period, filed under it, accepted. Drafts carry no period;
--      it is resolved at posting.
--   3. A draft that reaches 'posted' without an entry_no or a posted_at is a
--      real entry missing its identity. The 0001 CHECK covers 'posted'; this
--      adds the other direction, so a draft cannot carry them either.
-- =============================================================================

-- 1 -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION guard_entry_ledger() RETURNS trigger AS $$
BEGIN
  IF NEW.ledger_id IS DISTINCT FROM OLD.ledger_id THEN
    RAISE EXCEPTION 'Entry % cannot be moved to another ledger', COALESCE(OLD.entry_no, OLD.id::text);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_entry_ledger_immutable
  BEFORE UPDATE ON journal_entry
  FOR EACH ROW EXECUTE FUNCTION guard_entry_ledger();

-- 2 -------------------------------------------------------------------------
ALTER TABLE journal_entry ADD CONSTRAINT journal_entry_draft_is_bare
  CHECK (status <> 'draft' OR (entry_no IS NULL AND period_id IS NULL AND posted_at IS NULL));

-- 3 -------------------------------------------------------------------------
-- A draft's whole life is recorded: saved, edited, discarded, posted. The
-- 'post' row already comes from the posting service.
CREATE OR REPLACE FUNCTION log_draft_lifecycle() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'draft' THEN
      INSERT INTO audit_log (actor, action, table_name, record_id, after, context)
      VALUES (NEW.created_by, 'save_draft', 'journal_entry', NEW.id::text,
              jsonb_build_object('entry_date', NEW.entry_date, 'description', NEW.description),
              jsonb_build_object('ledger_id', NEW.ledger_id));
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'draft' THEN
      INSERT INTO audit_log (actor, action, table_name, record_id, before)
      VALUES (current_user, 'discard_draft', 'journal_entry', OLD.id::text,
              jsonb_build_object('entry_date', OLD.entry_date, 'description', OLD.description));
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'draft' AND NEW.status = 'draft'
     AND (NEW.entry_date IS DISTINCT FROM OLD.entry_date
       OR NEW.description IS DISTINCT FROM OLD.description) THEN
    INSERT INTO audit_log (actor, action, table_name, record_id, before, after)
    VALUES (current_user, 'edit_draft', 'journal_entry', NEW.id::text,
            jsonb_build_object('entry_date', OLD.entry_date, 'description', OLD.description),
            jsonb_build_object('entry_date', NEW.entry_date, 'description', NEW.description));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_draft_lifecycle
  AFTER INSERT OR UPDATE ON journal_entry
  FOR EACH ROW EXECUTE FUNCTION log_draft_lifecycle();

CREATE TRIGGER trg_draft_discard
  BEFORE DELETE ON journal_entry
  FOR EACH ROW EXECUTE FUNCTION log_draft_lifecycle();

-- 4 -------------------------------------------------------------------------
-- Drafts are excluded from every balance and every statement — they are not
-- the ledger yet. This reports drafts that have gone stale so they are visible
-- rather than quietly accumulating: unbalanced, or dated in a period that has
-- since closed, or older than the given number of days.
CREATE OR REPLACE FUNCTION check_stale_drafts(p_ledger_id uuid, p_days int DEFAULT 30)
RETURNS TABLE (
  id text, entry_date date, description text, net_cents bigint, age_days int, reason text
) AS $$
  SELECT je.id::text, je.entry_date, je.description,
         COALESCE(SUM(jl.amount), 0)::bigint,
         EXTRACT(DAY FROM now() - je.created_at)::int,
         CASE
           WHEN COALESCE(SUM(jl.amount), 0) <> 0 THEN 'does not balance'
           WHEN NOT EXISTS (SELECT 1 FROM fiscal_period fp
                             WHERE fp.ledger_id = je.ledger_id
                               AND je.entry_date BETWEEN fp.start_date AND fp.end_date)
             THEN 'no fiscal period covers its date'
           WHEN EXISTS (SELECT 1 FROM fiscal_period fp
                         WHERE fp.ledger_id = je.ledger_id
                           AND je.entry_date BETWEEN fp.start_date AND fp.end_date
                           AND fp.status <> 'open')
             THEN 'its period has closed since it was saved'
           ELSE 'older than ' || p_days || ' days'
         END
    FROM journal_entry je
    LEFT JOIN journal_line jl ON jl.entry_id = je.id
   WHERE je.ledger_id = p_ledger_id AND je.status = 'draft'
   GROUP BY je.id, je.entry_date, je.description, je.created_at, je.ledger_id
  HAVING COALESCE(SUM(jl.amount), 0) <> 0
      OR EXTRACT(DAY FROM now() - je.created_at)::int > p_days
      OR NOT EXISTS (SELECT 1 FROM fiscal_period fp
                      WHERE fp.ledger_id = je.ledger_id
                        AND je.entry_date BETWEEN fp.start_date AND fp.end_date
                        AND fp.status = 'open')
   ORDER BY je.entry_date;
$$ LANGUAGE sql STABLE;
