-- Budgets describe a fiscal year. They never write a financial journal.
CREATE TABLE budget (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 entity_id uuid NOT NULL REFERENCES entity(id), ledger_id uuid NOT NULL REFERENCES ledger(id),
 fiscal_year_id uuid NOT NULL REFERENCES fiscal_year(id),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','archived')),
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 copied_from_id uuid REFERENCES budget(id),
 created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 published_at timestamptz, archived_at timestamptz
);
CREATE INDEX budget_company_year ON budget(entity_id,fiscal_year_id,status);
CREATE TABLE budget_line (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), budget_id uuid NOT NULL REFERENCES budget(id),
 account_id uuid NOT NULL REFERENCES account(id), period_id uuid NOT NULL REFERENCES fiscal_period(id),
 amount bigint NOT NULL, UNIQUE(budget_id,account_id,period_id)
);
CREATE FUNCTION p3_budget_scope() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM fiscal_year fy JOIN ledger l ON l.id=fy.ledger_id
   WHERE fy.id=NEW.fiscal_year_id AND l.id=NEW.ledger_id AND l.entity_id=NEW.entity_id)
 THEN RAISE EXCEPTION 'P3_BUDGET_SCOPE'; END IF;
 IF NEW.copied_from_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM budget WHERE id=NEW.copied_from_id AND ledger_id=NEW.ledger_id)
 THEN RAISE EXCEPTION 'P3_BUDGET_COPY_SCOPE'; END IF;
 IF TG_OP='UPDATE' AND (NEW.ledger_id<>OLD.ledger_id OR NEW.entity_id<>OLD.entity_id OR NEW.fiscal_year_id<>OLD.fiscal_year_id
   OR NEW.copied_from_id IS DISTINCT FROM OLD.copied_from_id) THEN RAISE EXCEPTION 'P3_BUDGET_IDENTITY'; END IF;
 IF TG_OP='UPDATE' AND OLD.status<>'draft' AND (to_jsonb(NEW)-ARRAY['status','version','archived_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','version','archived_at'])
 THEN RAISE EXCEPTION 'P3_PUBLISHED_BUDGET_IMMUTABLE'; END IF;
 IF TG_OP='UPDATE' AND NEW.status<>OLD.status AND NOT (OLD.status='draft' AND NEW.status IN ('published','archived') OR OLD.status='published' AND NEW.status='archived')
 THEN RAISE EXCEPTION 'P3_BUDGET_TRANSITION'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER p3_budget_scope BEFORE INSERT OR UPDATE ON budget FOR EACH ROW EXECUTE FUNCTION p3_budget_scope();
CREATE TRIGGER p3_budget_version BEFORE UPDATE ON budget FOR EACH ROW EXECUTE FUNCTION p1_bump_version();
CREATE FUNCTION p3_budget_line_scope() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE b budget%ROWTYPE; BEGIN
 SELECT * INTO b FROM budget WHERE id=COALESCE(NEW.budget_id,OLD.budget_id) FOR UPDATE;
 IF b.status IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'P3_PUBLISHED_BUDGET_IMMUTABLE'; END IF;
 IF TG_OP='UPDATE' AND NEW.budget_id<>OLD.budget_id THEN RAISE EXCEPTION 'P3_BUDGET_LINE_OWNER'; END IF;
 IF TG_OP<>'DELETE' AND NOT EXISTS(SELECT 1 FROM account a JOIN fiscal_period fp ON fp.id=NEW.period_id
   WHERE a.id=NEW.account_id AND a.entity_id=b.entity_id AND a.account_type IN ('revenue','expense') AND a.is_active AND a.is_postable
     AND fp.fiscal_year_id=b.fiscal_year_id AND fp.ledger_id=b.ledger_id) THEN RAISE EXCEPTION 'P3_BUDGET_LINE_SCOPE'; END IF;
 RETURN COALESCE(NEW,OLD); END $$;
CREATE TRIGGER p3_budget_line_scope BEFORE INSERT OR UPDATE OR DELETE ON budget_line FOR EACH ROW EXECUTE FUNCTION p3_budget_line_scope();
ALTER TABLE document_edit_lease ADD COLUMN migration_run_id uuid UNIQUE REFERENCES migration_run(id) ON DELETE CASCADE,
 ADD COLUMN budget_id uuid UNIQUE REFERENCES budget(id) ON DELETE CASCADE;
ALTER TABLE document_edit_lease DROP CONSTRAINT document_edit_lease_one_resource;
ALTER TABLE document_edit_lease ADD CONSTRAINT document_edit_lease_one_resource
 CHECK(num_nonnulls(invoice_id,journal_entry_id,inbox_item_id,recurring_template_id,reminder_rule_id,migration_run_id,budget_id)=1);
CREATE OR REPLACE FUNCTION p1_lease_scope() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.invoice_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM invoice WHERE id=NEW.invoice_id AND ledger_id=NEW.ledger_id)
 OR NEW.journal_entry_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM journal_entry WHERE id=NEW.journal_entry_id AND ledger_id=NEW.ledger_id)
 OR NEW.inbox_item_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM inbox_item WHERE id=NEW.inbox_item_id AND ledger_id=NEW.ledger_id)
 OR NEW.recurring_template_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM recurring_template WHERE id=NEW.recurring_template_id AND ledger_id=NEW.ledger_id)
 OR NEW.reminder_rule_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM reminder_rule WHERE id=NEW.reminder_rule_id AND ledger_id=NEW.ledger_id)
 OR NEW.migration_run_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM migration_run WHERE id=NEW.migration_run_id AND ledger_id=NEW.ledger_id)
 OR NEW.budget_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM budget WHERE id=NEW.budget_id AND ledger_id=NEW.ledger_id)
 THEN RAISE EXCEPTION 'EDIT_LEASE_SCOPE'; END IF;
 IF NOT EXISTS(SELECT 1 FROM user_session WHERE token_hash=NEW.session_hash AND user_id=NEW.holder_user_id) THEN RAISE EXCEPTION 'EDIT_LEASE_SESSION'; END IF;
 RETURN NEW; END $$;
