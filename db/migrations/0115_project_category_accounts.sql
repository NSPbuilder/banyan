-- Company-owned category mappings. Existing posted documents keep their
-- original line accounts; this provisions defaults for new Project lines.
ALTER TABLE project_record_line DROP CONSTRAINT project_record_line_kind_check;
ALTER TABLE project_record_line ADD CONSTRAINT project_record_line_kind_check
  CHECK (kind IN ('revenue','material','labor','subcontractor','janitorial','delivery','other'));

CREATE TABLE project_category_account (
  entity_id uuid NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
  category text NOT NULL CHECK (category IN ('revenue','material','labor','subcontractor','janitorial','delivery','other')),
  account_id uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_id,category)
);

CREATE FUNCTION check_project_category_account() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM account a WHERE a.id=NEW.account_id
    AND a.entity_id=NEW.entity_id
    AND a.account_type::text=CASE WHEN NEW.category='revenue' THEN 'revenue' ELSE 'expense' END
    AND a.normal_balance::text=CASE WHEN NEW.category='revenue' THEN 'credit' ELSE 'debit' END)
  THEN RAISE EXCEPTION 'PROJECT_ACCOUNT_SCOPE: Project category account must belong to this company and have the correct type and balance'; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER project_category_account_scope BEFORE INSERT OR UPDATE ON project_category_account
  FOR EACH ROW EXECUTE FUNCTION check_project_category_account();

-- One initializer for migration, module activation, new-company setup and
-- transaction-time repairs. The advisory lock avoids lock upgrades on entity
-- rows already read by Project's ordinary writes.
CREATE FUNCTION ensure_project_category_accounts(p_entity uuid,p_actor text) RETURNS void AS $$
DECLARE spec record; a account; existing uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('project_accounts:'||p_entity::text,0));
  IF NOT EXISTS(SELECT 1 FROM entity WHERE id=p_entity) THEN
    RAISE EXCEPTION 'PROJECT_ACCOUNT_SETUP: That company does not exist';
  END IF;
  IF EXISTS(SELECT 1 FROM company_module_access WHERE entity_id=p_entity AND module='/projects' AND NOT enabled) THEN
    RAISE EXCEPTION 'PROJECT_ACCOUNT_SETUP: Enable Project for this company before creating its accounts';
  END IF;
  PERFORM set_config('app.actor',p_actor,true);
  FOR spec IN SELECT * FROM (VALUES
    ('revenue','8000','Sales of goods and services','revenue','revenue_from_contracts'),
    ('material','8320','Purchases and materials','expense','raw_materials_and_consumables'),
    ('labor','8340','Direct wages','expense','employee_benefits_expense'),
    ('subcontractor','8360','Trades and subcontracts','expense','other_operating_expenses'),
    ('janitorial','8360','Trades and subcontracts','expense','other_operating_expenses'),
    ('delivery','8457','Freight-in and duty','expense','other_operating_expenses'),
    ('other','8450','Other direct costs','expense','other_operating_expenses')
  ) AS defaults(category,code,name,kind,nature) LOOP
    SELECT account_id INTO existing FROM project_category_account
      WHERE entity_id=p_entity AND category=spec.category;
    IF existing IS NOT NULL THEN
      SELECT * INTO a FROM account WHERE id=existing FOR SHARE;
    ELSE
      SELECT * INTO a FROM account WHERE entity_id=p_entity AND code=spec.code FOR SHARE;
      IF a.id IS NULL THEN
        INSERT INTO account(entity_id,code,name,account_type,normal_balance)
          VALUES(p_entity,spec.code,spec.name,spec.kind::account_type,
            (CASE WHEN spec.kind='revenue' THEN 'credit' ELSE 'debit' END)::normal_balance)
          ON CONFLICT(entity_id,code) DO NOTHING;
        SELECT * INTO a FROM account WHERE entity_id=p_entity AND code=spec.code FOR SHARE;
        -- New accounts receive both their nature and cost-of-sales role.
        -- An existing account's classifications are preserved below.
      END IF;
    END IF;
    IF a.id IS NULL OR a.account_type::text<>spec.kind OR NOT a.is_active OR NOT a.is_postable
      OR a.normal_balance::text<>(CASE WHEN spec.kind='revenue' THEN 'credit' ELSE 'debit' END)
      OR cardinality(a.required_dimensions)>0 THEN
      RAISE EXCEPTION 'PROJECT_ACCOUNT_SETUP: Account % for % must be an active, postable % account with its normal balance and no required dimensions. Review it in Accounts.',spec.code,spec.category,spec.kind;
    END IF;
    IF existing IS NULL THEN
      -- Supply missing role families; never replace classifications already
      -- chosen by the company, including on accounts with historical activity.
      INSERT INTO account_role(account_id,role)
        SELECT a.id,spec.nature WHERE NOT EXISTS(
          SELECT 1 FROM account_role ar JOIN role_definition rd ON rd.code=ar.role
          WHERE ar.account_id=a.id AND rd.family=(SELECT family FROM role_definition WHERE code=spec.nature));
      IF spec.kind='expense' THEN
        INSERT INTO account_role(account_id,role)
          SELECT a.id,'fn_cost_of_sales' WHERE NOT EXISTS(
            SELECT 1 FROM account_role ar JOIN role_definition rd ON rd.code=ar.role
            WHERE ar.account_id=a.id AND rd.family=(SELECT family FROM role_definition WHERE code='fn_cost_of_sales'));
      END IF;
      INSERT INTO project_category_account(entity_id,category,account_id,created_by)
        VALUES(p_entity,spec.category,a.id,p_actor);
      INSERT INTO audit_log(actor,action,table_name,record_id,entity_id,scope,after)
        VALUES(p_actor,'bind_project_account','project_category_account',p_entity::text,p_entity,'company',
          jsonb_build_object('category',spec.category,'accountId',a.id,'code',a.code));
    END IF;
  END LOOP;
END; $$ LANGUAGE plpgsql;

-- Existing companies already have Project enabled by default. Provision them
-- without touching historical documents. A conflicting custom chart needs an
-- explicit correction; it must not block installation for other companies.
DO $$ DECLARE e record; BEGIN
  FOR e IN SELECT id FROM entity WHERE archived_at IS NULL AND NOT EXISTS(
    SELECT 1 FROM company_module_access WHERE entity_id=entity.id AND module='/projects' AND NOT enabled)
  LOOP
    BEGIN
      PERFORM ensure_project_category_accounts(e.id,'system:project-account-setup');
    EXCEPTION WHEN raise_exception THEN
      IF position('PROJECT_ACCOUNT_SETUP:' IN SQLERRM)=0 THEN RAISE; END IF;
      RAISE NOTICE 'Project accounts for company % need review: %',e.id,SQLERRM;
    END;
  END LOOP;
END; $$;
