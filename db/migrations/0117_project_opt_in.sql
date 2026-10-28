-- Missing Project permission is not company activation. Preserve explicit
-- switches and legacy companies that already have Project data.
INSERT INTO company_module_access(entity_id,module,enabled,updated_by)
  SELECT e.id,'/projects',EXISTS(SELECT 1 FROM project p WHERE p.entity_id=e.id),
    'system:project-opt-in-repair'
  FROM entity e
  ON CONFLICT(entity_id,module) DO NOTHING;

ALTER FUNCTION ensure_project_category_accounts(uuid,text)
  RENAME TO ensure_project_category_accounts_v116;
CREATE FUNCTION ensure_project_category_accounts(p_entity uuid,p_actor text) RETURNS void AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('project_accounts:'||p_entity::text,0));
  IF NOT EXISTS(SELECT 1 FROM company_module_access
    WHERE entity_id=p_entity AND module='/projects' AND enabled) THEN
    RAISE EXCEPTION 'PROJECT_ACCOUNT_SETUP: Enable Project for this company in Company access before creating its accounts';
  END IF;
  PERFORM ensure_project_category_accounts_v116(p_entity,p_actor);
END; $$ LANGUAGE plpgsql;

-- Undo only untouched accounts created by the two erroneous upgrade routines.
-- Never identify ownership from a GIFI code alone. Every account reference is
-- checked, including zero balance caches, drafts and custom child accounts.
DO $$
DECLARE a record; ref record; used boolean; safe boolean; mapping record;
BEGIN
  PERFORM set_config('app.actor','system:project-opt-in-repair',true);
  FOR a IN
    SELECT acct.* FROM account acct
    JOIN company_module_access c ON c.entity_id=acct.entity_id AND c.module='/projects' AND NOT c.enabled
    WHERE NOT EXISTS(SELECT 1 FROM project p WHERE p.entity_id=acct.entity_id)
      AND acct.code IN ('8000','8320','8340','8360','8450','8457','8518')
      AND acct.is_active AND acct.is_postable=(acct.code<>'8518')
      AND acct.description IS NULL AND acct.sred_category IS NULL
      AND cardinality(acct.required_dimensions)=0 AND acct.updated_at=acct.created_at
      AND (acct.parent_id IS NULL OR EXISTS(SELECT 1 FROM account p
        WHERE p.id=acct.parent_id AND p.entity_id=acct.entity_id AND p.code='8518'))
      AND EXISTS(SELECT 1 FROM audit_log l WHERE l.table_name='account' AND l.record_id=acct.id::text
        AND l.action='create_account'
        AND l.actor IN ('system:project-account-setup','system:project-cost-sales-group')
        AND l.after->>'code'=acct.code AND l.after->>'name'=acct.name
        AND l.after->>'type'=acct.account_type::text AND l.after->>'normal_balance'=acct.normal_balance::text)
      AND NOT EXISTS(SELECT 1 FROM audit_log l WHERE l.table_name='account' AND l.record_id=acct.id::text
        AND l.actor NOT IN ('system:project-account-setup','system:project-cost-sales-group'))
      AND NOT EXISTS(SELECT 1 FROM project_category_account m WHERE m.account_id=acct.id
        AND m.created_by NOT IN ('system:project-account-setup','system:project-cost-sales-group'))
      AND ARRAY(SELECT r.role FROM account_role r WHERE r.account_id=acct.id ORDER BY r.role)=
        CASE acct.code
          WHEN '8000' THEN ARRAY['revenue_from_contracts']
          WHEN '8320' THEN ARRAY['fn_cost_of_sales','raw_materials_and_consumables']
          WHEN '8340' THEN ARRAY['employee_benefits_expense','fn_cost_of_sales']
          WHEN '8518' THEN ARRAY[]::text[]
          ELSE ARRAY['fn_cost_of_sales','other_operating_expenses'] END
    ORDER BY acct.code,acct.id FOR UPDATE OF acct
  LOOP
    safe:=true;
    FOR ref IN
      SELECT c.conrelid::regclass AS table_name,att.attname AS column_name,
        cardinality(c.conkey) AS columns
      FROM pg_constraint c
      JOIN pg_attribute att ON att.attrelid=c.conrelid AND att.attnum=c.conkey[1]
      WHERE c.contype='f' AND c.confrelid='account'::regclass
        AND c.conrelid NOT IN ('account_role'::regclass,'project_category_account'::regclass)
    LOOP
      IF ref.columns<>1 THEN safe:=false; EXIT; END IF;
      EXECUTE format('SELECT EXISTS(SELECT 1 FROM %s WHERE %I=$1)',ref.table_name,ref.column_name)
        INTO used USING a.id;
      IF used THEN safe:=false; EXIT; END IF;
    END LOOP;
    IF safe THEN
      DELETE FROM account WHERE id=a.id;
      INSERT INTO audit_log(actor,action,table_name,record_id,entity_id,scope,before,context)
        VALUES('system:project-opt-in-repair','remove_unused_project_default','account',a.id::text,a.entity_id,
          'company',to_jsonb(a),jsonb_build_object('reason','Project was never activated; unused upgrade-created default'));
    END IF;
  END LOOP;
  -- Reused/manual and used accounts survive. Remove only installation-created
  -- mappings for the never-used, disabled module; activation can bind them again.
  FOR mapping IN DELETE FROM project_category_account m
    USING company_module_access c
    WHERE c.entity_id=m.entity_id AND c.module='/projects' AND NOT c.enabled
      AND NOT EXISTS(SELECT 1 FROM project p WHERE p.entity_id=m.entity_id)
      AND m.created_by IN ('system:project-account-setup','system:project-cost-sales-group')
    RETURNING m.*
  LOOP
    INSERT INTO audit_log(actor,action,table_name,record_id,entity_id,scope,before)
      VALUES('system:project-opt-in-repair','remove_unused_project_binding','project_category_account',
        mapping.entity_id::text,mapping.entity_id,'company',to_jsonb(mapping));
  END LOOP;
END; $$;
