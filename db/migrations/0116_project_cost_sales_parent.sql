-- Project's automatic direct-cost accounts share a Cost of sales heading.
-- Keep 0115 immutable and preserve its single category provisioning routine.
ALTER FUNCTION ensure_project_category_accounts(uuid,text)
  RENAME TO ensure_project_category_accounts_v115;

CREATE FUNCTION ensure_project_category_accounts(p_entity uuid,p_actor text) RETURNS void AS $$
DECLARE heading account; item record;
BEGIN
  -- The original routine holds this transaction's company provisioning lock.
  PERFORM ensure_project_category_accounts_v115(p_entity,p_actor);
  SELECT * INTO heading FROM account WHERE entity_id=p_entity AND code='8518' FOR SHARE;
  IF heading.id IS NULL THEN
    INSERT INTO account(entity_id,code,name,account_type,normal_balance,is_postable)
      VALUES(p_entity,'8518','Cost of sales','expense','debit',false)
      ON CONFLICT(entity_id,code) DO NOTHING;
    SELECT * INTO heading FROM account WHERE entity_id=p_entity AND code='8518' FOR SHARE;
  END IF;
  IF heading.id IS NULL OR heading.account_type<>'expense' OR heading.normal_balance<>'debit' OR NOT heading.is_active THEN
    RAISE EXCEPTION 'PROJECT_ACCOUNT_SETUP: Account 8518 must be an active expense account with a debit normal balance to group Project costs. Review it in Accounts.';
  END IF;
  IF EXISTS(SELECT 1 FROM project_category_account WHERE entity_id=p_entity AND category<>'revenue' AND account_id=heading.id) THEN
    RAISE EXCEPTION 'PROJECT_ACCOUNT_SETUP: Account 8518 is already used as a Project cost item. It cannot also be the Cost of sales parent. Review it in Accounts.';
  END IF;
  FOR item IN SELECT DISTINCT a.id,a.code FROM project_category_account m
    JOIN account a ON a.id=m.account_id
    WHERE m.entity_id=p_entity AND m.category<>'revenue' AND a.parent_id IS NULL
  LOOP
    BEGIN
      UPDATE account SET parent_id=heading.id WHERE id=item.id AND parent_id IS NULL;
    EXCEPTION WHEN raise_exception THEN
      RAISE EXCEPTION 'PROJECT_ACCOUNT_SETUP: Cannot group Project cost account % under 8518: %',item.code,SQLERRM;
    END;
    INSERT INTO audit_log(actor,action,table_name,record_id,entity_id,scope,after)
      VALUES(p_actor,'group_project_cost_account','account',item.id::text,p_entity,'company',
        jsonb_build_object('parentId',heading.id,'parentCode',heading.code,'code',item.code));
  END LOOP;
END; $$ LANGUAGE plpgsql;

-- Fill missing headings for the accounts provisioned by 0115. Existing custom
-- parent relationships, account IDs, roles and all financial rows are retained.
DO $$ DECLARE e record; BEGIN
  FOR e IN SELECT id FROM entity WHERE archived_at IS NULL AND NOT EXISTS(
    SELECT 1 FROM company_module_access WHERE entity_id=entity.id AND module='/projects' AND NOT enabled)
  LOOP
    BEGIN
      PERFORM ensure_project_category_accounts(e.id,'system:project-cost-sales-group');
    EXCEPTION WHEN raise_exception THEN
      IF position('PROJECT_ACCOUNT_SETUP:' IN SQLERRM)=0 THEN RAISE; END IF;
      RAISE NOTICE 'Project cost group for company % needs review: %',e.id,SQLERRM;
    END;
  END LOOP;
END; $$;
