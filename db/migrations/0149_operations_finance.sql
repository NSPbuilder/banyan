-- Reviewed ledger connections. Existing registers are not booked twice.
ALTER TABLE journal_entry DROP CONSTRAINT journal_entry_source_type_check;
ALTER TABLE journal_entry ADD CONSTRAINT journal_entry_source_type_check CHECK(source_type IN
 ('manual','opening_balance','ar_invoice','ap_bill','payment','bank','period_close','adjustment',
  'quick_expense','quick_income','payroll','fixed_asset','asset_depreciation','asset_deferred_tax','inventory','production','operations_opening'));

-- One canonical GIFI catalogue, shared by provisioning and the setup preview.
CREATE FUNCTION operations_account_specs(p_seat text) RETURNS TABLE
 (key text,code text,label text,kind text,balance text,role text,function_role text,controlled boolean)
 LANGUAGE sql IMMUTABLE AS $$
 SELECT key,code,label,kind,balance,role,function_role,controlled FROM (VALUES
 ('/assets','land','1600','Land','asset','debit','property_plant_equipment',NULL,true),
 ('/assets','building','1620','Buildings','asset','debit','property_plant_equipment',NULL,true),
 ('/assets','building_accumulated','1621','Accumulated amortization - buildings','asset','credit','accumulated_depreciation_ppe',NULL,true),
 ('/assets','machinery','1740','Machinery and equipment','asset','debit','property_plant_equipment',NULL,true),
 ('/assets','machinery_accumulated','1741','Accumulated amortization - machinery','asset','credit','accumulated_depreciation_ppe',NULL,true),
 ('/assets','vehicle','1742','Motor vehicles','asset','debit','property_plant_equipment',NULL,true),
 ('/assets','vehicle_accumulated','1743','Accumulated amortization - motor vehicles','asset','credit','accumulated_depreciation_ppe',NULL,true),
 ('/assets','computer','1774','Computer equipment','asset','debit','property_plant_equipment',NULL,true),
 ('/assets','computer_accumulated','1775','Accumulated amortization - computers','asset','credit','accumulated_depreciation_ppe',NULL,true),
 ('/assets','depreciation','8670','Amortization of tangible assets','expense','debit','depreciation_expense','fn_administrative_expenses',false),
 ('/assets','disposal','8210','Gain or loss on disposal of assets','revenue','credit','gain_on_disposal',NULL,false),
 ('/assets','deferred_asset','2421','Deferred income tax asset','asset','debit','deferred_tax_assets',NULL,true),
 ('/assets','deferred_liability','3240','Deferred income tax liability','liability','credit','deferred_tax_liabilities',NULL,true),
 ('/assets','deferred_expense','9995','Deferred income tax provision','expense','debit','income_tax_deferred',NULL,false),
 ('/inventory','raw_material','1126','Raw materials','asset','debit','inventories',NULL,true),
 ('/inventory','wip','1125','Work in progress','asset','debit','inventories',NULL,true),
 ('/inventory','finished_goods','1121','Finished goods','asset','debit','inventories',NULL,true),
 ('/inventory','cogs','8518-INV','Inventory cost of sales','expense','debit','changes_in_inventories','fn_cost_of_sales',false),
 ('/inventory','adjustment','8458','Inventory adjustments and production losses','expense','debit','changes_in_inventories','fn_cost_of_sales',false)
 ) AS s(seat,key,code,label,kind,balance,role,function_role,controlled) WHERE seat=p_seat
$$;

CREATE TABLE operations_account (
 entity_id uuid NOT NULL REFERENCES entity(id),seat text NOT NULL CHECK(seat IN ('/assets','/inventory')),
 key text NOT NULL,account_id uuid NOT NULL REFERENCES account(id),created_by text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(entity_id,seat,key),UNIQUE(entity_id,seat,account_id)
);
CREATE TABLE operations_finance_setting (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),ledger_id uuid NOT NULL REFERENCES ledger(id),
 seat text NOT NULL CHECK(seat IN ('/assets','/inventory')),connected_on date,connected_at timestamptz,
 funding_account_id uuid REFERENCES account(id),oci_account_id uuid REFERENCES account(id),equity_account_id uuid REFERENCES account(id),
 tax_rate_bp integer NOT NULL DEFAULT 0 CHECK(tax_rate_bp BETWEEN 0 AND 10000),tax_rate_note text NOT NULL DEFAULT '',
 cca_strategy text NOT NULL DEFAULT 'maximum' CHECK(cca_strategy IN ('maximum','match_book')),
 opening_snapshot jsonb,version integer NOT NULL DEFAULT 1 CHECK(version>0),created_by text NOT NULL,
 UNIQUE(ledger_id,seat),UNIQUE(ledger_id,id),CHECK((connected_on IS NULL)=(connected_at IS NULL)),
 CHECK(connected_on IS NULL OR opening_snapshot IS NOT NULL)
);
CREATE TABLE asset_ledger_assignment (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),ledger_id uuid NOT NULL REFERENCES ledger(id),asset_id uuid NOT NULL,
 group_key text NOT NULL CHECK(group_key IN ('land','building','machinery','vehicle','computer')),
 funding_account_id uuid REFERENCES account(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),created_by text NOT NULL,
 UNIQUE(ledger_id,asset_id),FOREIGN KEY(ledger_id,asset_id) REFERENCES fixed_asset(ledger_id,id)
);
CREATE TABLE operations_journal_event (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),ledger_id uuid NOT NULL REFERENCES ledger(id),
 seat text NOT NULL CHECK(seat IN ('/assets','/inventory')),
 source_kind text NOT NULL CHECK(source_kind IN ('opening','asset_acquisition','asset_disposal','depreciation','deferred_tax','inventory','production')),
 source_id uuid NOT NULL,event_date date NOT NULL,entry_id uuid UNIQUE REFERENCES journal_entry(id),
 movement_id uuid,lines jsonb NOT NULL CHECK(jsonb_typeof(lines)='array'),snapshot jsonb NOT NULL,
 no_entry_reason text NOT NULL DEFAULT '',created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(ledger_id,source_kind,source_id),UNIQUE(ledger_id,movement_id),UNIQUE(ledger_id,id),
 FOREIGN KEY(ledger_id,movement_id) REFERENCES inventory_movement(ledger_id,id),
 CHECK((entry_id IS NULL)=(jsonb_array_length(lines)=0)),CHECK(entry_id IS NOT NULL OR length(btrim(no_entry_reason))>0)
);
CREATE INDEX operations_journal_date ON operations_journal_event(ledger_id,seat,event_date);

CREATE UNIQUE INDEX operations_asset_request_unique ON operations_journal_event(ledger_id,(snapshot->>'requestKey')) WHERE source_kind='asset_acquisition' AND snapshot->>'requestKey' IS NOT NULL;

CREATE TABLE production_time (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),ledger_id uuid NOT NULL REFERENCES ledger(id),order_id uuid NOT NULL,
 employee_id uuid NOT NULL REFERENCES payroll_employee(id),work_date date NOT NULL,hours bigint NOT NULL CHECK(hours>0),
 note text NOT NULL CHECK(length(btrim(note)) BETWEEN 1 AND 10000),cancelled boolean NOT NULL DEFAULT false,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),request_key uuid NOT NULL,request_hash text NOT NULL,
 created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(ledger_id,id),UNIQUE(ledger_id,request_key),
 FOREIGN KEY(ledger_id,order_id) REFERENCES production_order(ledger_id,id)
);
CREATE TABLE production_payroll_allocation (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),ledger_id uuid NOT NULL REFERENCES ledger(id),time_id uuid NOT NULL,
 pay_stub_id uuid NOT NULL REFERENCES pay_stub(id),event_id uuid NOT NULL,hours bigint NOT NULL CHECK(hours>0),
 gross_cost bigint NOT NULL CHECK(gross_cost>=0),employer_cost bigint NOT NULL CHECK(employer_cost>=0),
 snapshot jsonb NOT NULL,request_key uuid NOT NULL,request_hash text NOT NULL,created_by text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(ledger_id,id),UNIQUE(ledger_id,event_id),UNIQUE(ledger_id,request_key),
 FOREIGN KEY(ledger_id,time_id) REFERENCES production_time(ledger_id,id),FOREIGN KEY(ledger_id,event_id) REFERENCES production_event(ledger_id,id)
);
CREATE TABLE production_payroll_reversal (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),ledger_id uuid NOT NULL REFERENCES ledger(id),allocation_id uuid NOT NULL,
 event_id uuid NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 10000),
 request_key uuid NOT NULL,request_hash text NOT NULL,created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(ledger_id,allocation_id),UNIQUE(ledger_id,event_id),UNIQUE(ledger_id,request_key),
 FOREIGN KEY(ledger_id,allocation_id) REFERENCES production_payroll_allocation(ledger_id,id),
 FOREIGN KEY(ledger_id,event_id) REFERENCES production_event(ledger_id,id)
);
ALTER TABLE production_event DROP CONSTRAINT production_event_kind_check;
ALTER TABLE production_event ADD CONSTRAINT production_event_kind_check CHECK(kind IN
 ('material_issue','material_return','conversion_cost','completion','loss','cancel','labour_return'));

CREATE FUNCTION ensure_operations_accounts(p_entity uuid,p_seat text,p_actor text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE spec record; a account; mapped uuid; existing_role text;
BEGIN
 IF p_seat NOT IN ('/assets','/inventory') THEN RAISE EXCEPTION 'OPERATIONS_ACCOUNT_SETUP: Choose an operations module'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('operations_accounts:'||p_entity::text,0));
 IF NOT EXISTS(SELECT 1 FROM entity WHERE id=p_entity AND archived_at IS NULL)
  OR EXISTS(SELECT 1 FROM company_module_access WHERE entity_id=p_entity AND module=p_seat AND NOT enabled)
 THEN RAISE EXCEPTION 'OPERATIONS_ACCOUNT_SETUP: Enable this module for an active company first'; END IF;
 PERFORM set_config('app.actor',p_actor,true);
 FOR spec IN SELECT * FROM operations_account_specs(p_seat) LOOP
  SELECT account_id INTO mapped FROM operations_account WHERE entity_id=p_entity AND seat=p_seat AND key=spec.key;
  IF mapped IS NOT NULL THEN SELECT * INTO a FROM account WHERE id=mapped FOR SHARE;
  ELSE
   SELECT * INTO a FROM account WHERE entity_id=p_entity AND code=spec.code FOR SHARE;
   IF a.id IS NULL THEN
    INSERT INTO account(entity_id,code,name,account_type,normal_balance,description)
     VALUES(p_entity,spec.code,spec.label,spec.kind::account_type,spec.balance::normal_balance,'GIFI-based operations account')
     ON CONFLICT(entity_id,code) DO NOTHING;
    SELECT * INTO a FROM account WHERE entity_id=p_entity AND code=spec.code FOR SHARE;
   END IF;
  END IF;
  IF a.id IS NULL OR a.account_type::text<>spec.kind OR a.normal_balance::text<>spec.balance
   OR NOT a.is_active OR NOT a.is_postable OR cardinality(a.required_dimensions)>0
  THEN RAISE EXCEPTION 'OPERATIONS_ACCOUNT_SETUP: Review account % in Accounts; type, normal balance, posting and dimensions must match %',spec.code,spec.label; END IF;
  SELECT ar.role INTO existing_role FROM account_role ar JOIN role_definition r ON r.code=ar.role
   WHERE ar.account_id=a.id AND r.family=(SELECT family FROM role_definition WHERE code=spec.role);
  IF existing_role IS NOT NULL AND existing_role<>spec.role
  THEN RAISE EXCEPTION 'OPERATIONS_ACCOUNT_SETUP: Account % has a conflicting statement classification; review its roles',spec.code; END IF;
  INSERT INTO account_role(account_id,role) VALUES(a.id,spec.role) ON CONFLICT DO NOTHING;
  IF spec.function_role IS NOT NULL AND NOT EXISTS(SELECT 1 FROM account_role ar JOIN role_definition r ON r.code=ar.role WHERE ar.account_id=a.id AND r.family='function')
   THEN INSERT INTO account_role(account_id,role) VALUES(a.id,spec.function_role) ON CONFLICT DO NOTHING; END IF;
  IF mapped IS NULL THEN
   INSERT INTO operations_account(entity_id,seat,key,account_id,created_by) VALUES(p_entity,p_seat,spec.key,a.id,p_actor);
   INSERT INTO audit_log(actor,action,table_name,record_id,entity_id,scope,after)
    VALUES(p_actor,'bind_operations_account','operations_account',p_entity::text,p_entity,'company',jsonb_build_object('seat',p_seat,'key',spec.key,'accountId',a.id));
  END IF;
 END LOOP;
END $$;

-- The same values feed connection, reports and deferred reconciliation checks.
CREATE FUNCTION operations_financial_targets(p_ledger uuid,p_seat text,p_date date)
 RETURNS TABLE(key text,amount numeric) LANGUAGE sql STABLE AS $$
 WITH assets AS (
  SELECT a.*,coalesce(x.group_key,CASE WHEN lower(a.category)='land' THEN 'land'
   WHEN p.class_code='50' THEN 'computer' WHEN p.class_code IN ('10','10.1') THEN 'vehicle'
   WHEN p.class_code IN ('1','3','6') THEN 'building' ELSE 'machinery' END) AS grp,
   coalesce((SELECT sum(e.amount) FROM asset_depreciation_entry e WHERE e.asset_id=a.id AND e.entry_date<=p_date),0) AS amort
  FROM fixed_asset a LEFT JOIN asset_ledger_assignment x ON x.asset_id=a.id
   LEFT JOIN asset_cca_assignment ca ON ca.asset_id=a.id LEFT JOIN asset_cca_pool p ON p.id=ca.pool_id
  WHERE a.ledger_id=p_ledger AND a.acquired_on<=p_date AND (a.disposed_on IS NULL OR a.disposed_on>p_date)
 ), dt AS (SELECT DISTINCT ON(pool_id) liability,recognized_asset FROM asset_deferred_tax_review
   WHERE ledger_id=p_ledger AND reporting_date<=p_date ORDER BY pool_id,reporting_date DESC,revision DESC),
 amounts AS (
  SELECT grp AS key,sum(acquisition_cost)::numeric amount FROM assets WHERE p_seat='/assets' GROUP BY grp
  UNION ALL SELECT grp||'_accumulated',-sum(amort)::numeric FROM assets WHERE p_seat='/assets' AND grp<>'land' GROUP BY grp
  UNION ALL SELECT 'deferred_asset',coalesce(sum(recognized_asset),0)::numeric FROM dt WHERE p_seat='/assets'
  UNION ALL SELECT 'deferred_liability',-coalesce(sum(liability),0)::numeric FROM dt WHERE p_seat='/assets'
  UNION ALL SELECT CASE i.kind WHEN 'work_in_progress' THEN 'wip' ELSE i.kind END,
   sum(CASE WHEN m.kind IN ('receipt','adjust_in') THEN m.cost WHEN m.kind IN ('issue','adjust_out') THEN -m.cost ELSE 0 END)::numeric
   FROM inventory_movement m JOIN inventory_item i ON i.id=m.item_id
   WHERE m.ledger_id=p_ledger AND m.movement_date<=p_date AND p_seat='/inventory' GROUP BY i.kind
  UNION ALL SELECT 'wip',coalesce(sum(CASE WHEN kind IN ('material_issue','conversion_cost') THEN cost ELSE -cost END),0)::numeric
   FROM production_event WHERE ledger_id=p_ledger AND event_date<=p_date AND p_seat='/inventory'
 ) SELECT s.key,coalesce(sum(a.amount),0)::numeric FROM operations_account_specs(p_seat) s
 LEFT JOIN amounts a ON a.key=s.key WHERE s.controlled GROUP BY s.key
$$;

CREATE TRIGGER asset_ledger_assignment_immutable BEFORE UPDATE OR DELETE ON asset_ledger_assignment FOR EACH ROW EXECUTE FUNCTION operations_history_immutable();
CREATE TRIGGER operations_journal_event_immutable BEFORE UPDATE OR DELETE ON operations_journal_event FOR EACH ROW EXECUTE FUNCTION operations_history_immutable();
CREATE TRIGGER production_payroll_allocation_immutable BEFORE UPDATE OR DELETE ON production_payroll_allocation FOR EACH ROW EXECUTE FUNCTION operations_history_immutable();
CREATE TRIGGER production_payroll_reversal_immutable BEFORE UPDATE OR DELETE ON production_payroll_reversal FOR EACH ROW EXECUTE FUNCTION operations_history_immutable();
CREATE TRIGGER operations_finance_audit AFTER INSERT OR UPDATE ON operations_finance_setting FOR EACH ROW EXECUTE FUNCTION operations_audit();
CREATE TRIGGER operations_journal_audit AFTER INSERT ON operations_journal_event FOR EACH ROW EXECUTE FUNCTION operations_audit();
CREATE TRIGGER production_time_audit AFTER INSERT OR UPDATE ON production_time FOR EACH ROW EXECUTE FUNCTION operations_audit();
CREATE TRIGGER production_payroll_audit AFTER INSERT ON production_payroll_allocation FOR EACH ROW EXECUTE FUNCTION operations_audit();
CREATE TRIGGER production_payroll_reversal_audit AFTER INSERT ON production_payroll_reversal FOR EACH ROW EXECUTE FUNCTION operations_audit();

CREATE FUNCTION operations_finance_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='fixed_asset' AND EXISTS(SELECT 1 FROM asset_ledger_assignment WHERE asset_id=OLD.id) THEN
  IF (NEW.ledger_id,NEW.acquired_on,NEW.acquisition_cost) IS DISTINCT FROM (OLD.ledger_id,OLD.acquired_on,OLD.acquisition_cost)
   OR OLD.disposed_on IS NOT NULL AND (NEW.disposed_on,NEW.disposal_proceeds) IS DISTINCT FROM (OLD.disposed_on,OLD.disposal_proceeds)
  THEN RAISE EXCEPTION 'OPERATIONS_FINANCIAL_HISTORY: Posted asset values are fixed; use a source correction.'; END IF;
 ELSIF TG_TABLE_NAME='operations_finance_setting' THEN
  IF (NEW.ledger_id,NEW.seat,NEW.connected_on,NEW.connected_at,NEW.opening_snapshot) IS DISTINCT FROM
   (OLD.ledger_id,OLD.seat,OLD.connected_on,OLD.connected_at,OLD.opening_snapshot)
  THEN RAISE EXCEPTION 'OPERATIONS_FINANCIAL_HISTORY: The reviewed opening connection is fixed.'; END IF;
 ELSIF TG_TABLE_NAME='production_time' THEN
  IF (to_jsonb(NEW)-ARRAY['cancelled','version']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['cancelled','version'])
   OR OLD.cancelled OR EXISTS(SELECT 1 FROM production_payroll_allocation a WHERE a.time_id=OLD.id AND NOT EXISTS(SELECT 1 FROM production_payroll_reversal r WHERE r.allocation_id=a.id))
  THEN RAISE EXCEPTION 'PRODUCTION_TIME_HISTORY: Cancel unallocated time and enter a replacement.'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER asset_finance_identity BEFORE UPDATE ON fixed_asset FOR EACH ROW EXECUTE FUNCTION operations_finance_identity_guard();
CREATE TRIGGER operations_connection_identity BEFORE UPDATE ON operations_finance_setting FOR EACH ROW EXECUTE FUNCTION operations_finance_identity_guard();
CREATE TRIGGER production_time_identity BEFORE UPDATE ON production_time FOR EACH ROW EXECUTE FUNCTION operations_finance_identity_guard();

CREATE FUNCTION operations_validate_finance(l uuid) RETURNS void LANGUAGE plpgsql STABLE AS $$
DECLARE cfg operations_finance_setting; d date; e operations_journal_event; actual jsonb; expected jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM ledger WHERE id=l) THEN RETURN; END IF;
 IF EXISTS(SELECT 1 FROM operations_account m JOIN ledger lg ON lg.entity_id=m.entity_id WHERE lg.id=l AND NOT EXISTS(SELECT 1 FROM operations_account_specs(m.seat) s WHERE s.key=m.key)) THEN RAISE EXCEPTION 'OPERATIONS_ACCOUNT_SETUP: Unexpected module account key.'; END IF;
 IF EXISTS(SELECT 1 FROM operations_account m JOIN ledger lg ON lg.entity_id=m.entity_id
   JOIN operations_account_specs(m.seat) s ON s.key=m.key JOIN account a ON a.id=m.account_id
   WHERE lg.id=l AND (a.entity_id<>m.entity_id OR a.account_type::text<>s.kind OR a.normal_balance::text<>s.balance
    OR NOT a.is_active OR NOT a.is_postable OR cardinality(a.required_dimensions)>0
    OR NOT EXISTS(SELECT 1 FROM account_role WHERE account_id=a.id AND role=s.role)))
 THEN RAISE EXCEPTION 'OPERATIONS_ACCOUNT_SETUP: Preserve the mapped accounts and statement roles.'; END IF;
 FOR cfg IN SELECT * FROM operations_finance_setting WHERE ledger_id=l AND connected_on IS NOT NULL LOOP
  IF EXISTS(SELECT 1 FROM operations_account_specs(cfg.seat) s WHERE NOT EXISTS(SELECT 1 FROM operations_account m WHERE m.entity_id=(SELECT entity_id FROM ledger WHERE id=l) AND m.seat=cfg.seat AND m.key=s.key)) THEN RAISE EXCEPTION 'OPERATIONS_ACCOUNT_SETUP: Preserve every configured module account.'; END IF;
  IF EXISTS(SELECT 1 FROM unnest(ARRAY[cfg.funding_account_id,cfg.oci_account_id,cfg.equity_account_id]) selected(account_id) JOIN account a ON a.id=selected.account_id
   WHERE a.entity_id<>(SELECT entity_id FROM ledger WHERE id=l)) THEN RAISE EXCEPTION 'OPERATIONS_ACCOUNT_SCOPE'; END IF;
  IF NOT EXISTS(SELECT 1 FROM operations_journal_event WHERE ledger_id=l AND source_kind='opening' AND source_id=cfg.id AND event_date=cfg.connected_on)
   THEN RAISE EXCEPTION 'OPERATIONS_OPENING_SOURCE'; END IF;
  IF cfg.seat='/assets' AND (
   EXISTS(SELECT 1 FROM fixed_asset a WHERE a.ledger_id=l AND a.created_at>=cfg.connected_at AND
    (a.acquired_on<cfg.connected_on OR NOT EXISTS(SELECT 1 FROM asset_ledger_assignment x WHERE x.asset_id=a.id)
     OR NOT EXISTS(SELECT 1 FROM asset_depreciation_policy p WHERE p.asset_id=a.id)
     OR NOT EXISTS(SELECT 1 FROM asset_ledger_assignment x WHERE x.asset_id=a.id AND x.group_key='land') AND NOT EXISTS(SELECT 1 FROM asset_cca_assignment x WHERE x.asset_id=a.id)
     OR NOT EXISTS(SELECT 1 FROM operations_journal_event WHERE ledger_id=l AND source_kind='asset_acquisition' AND source_id=a.id)))
   OR EXISTS(SELECT 1 FROM asset_depreciation_entry s WHERE s.ledger_id=l AND s.created_at>=cfg.connected_at AND
    (s.entry_date<cfg.connected_on OR NOT EXISTS(SELECT 1 FROM operations_journal_event WHERE ledger_id=l AND source_kind='depreciation' AND source_id=s.id)))
   OR EXISTS(SELECT 1 FROM asset_deferred_tax_review s WHERE s.ledger_id=l AND s.created_at>=cfg.connected_at AND
    (s.reporting_date<cfg.connected_on OR NOT EXISTS(SELECT 1 FROM operations_journal_event WHERE ledger_id=l AND source_kind='deferred_tax' AND source_id=s.id))))
   THEN RAISE EXCEPTION 'OPERATIONS_ASSET_SOURCE: Record the policy, tax assignment and financial journal together.'; END IF;
  IF cfg.seat='/inventory' AND (
   EXISTS(SELECT 1 FROM inventory_movement s WHERE s.ledger_id=l AND s.created_at>=cfg.connected_at AND
    (s.movement_date<cfg.connected_on OR NOT EXISTS(SELECT 1 FROM operations_journal_event WHERE ledger_id=l AND movement_id=s.id)))
   OR EXISTS(SELECT 1 FROM production_event s WHERE s.ledger_id=l AND s.created_at>=cfg.connected_at AND
    (s.event_date<cfg.connected_on OR NOT EXISTS(SELECT 1 FROM operations_journal_event WHERE ledger_id=l AND source_kind='production' AND source_id=s.id))))
   THEN RAISE EXCEPTION 'OPERATIONS_INVENTORY_SOURCE: Record the movement and financial journal together.'; END IF;
  -- Check every historical cutoff as well as the latest balance. This also
  -- validates portable copies when triggers were disabled while loading.
  FOR d IN SELECT cfg.connected_on UNION SELECT event_date FROM operations_journal_event WHERE ledger_id=l AND seat=cfg.seat AND event_date>=cfg.connected_on
   UNION SELECT je.entry_date FROM journal_entry je JOIN journal_line jl ON jl.entry_id=je.id
    JOIN operations_account m ON m.account_id=jl.account_id WHERE je.ledger_id=l AND m.seat=cfg.seat AND je.entry_date>=cfg.connected_on LOOP
   IF EXISTS(SELECT 1 FROM operations_financial_targets(l,cfg.seat,d) t
    JOIN operations_account m ON m.entity_id=(SELECT entity_id FROM ledger WHERE id=l) AND m.seat=cfg.seat AND m.key=t.key
    WHERE t.amount<>coalesce((SELECT sum(jl.amount) FROM journal_line jl JOIN journal_entry je ON je.id=jl.entry_id
     WHERE jl.account_id=m.account_id AND je.ledger_id=l AND je.status IN ('posted','reversed') AND je.entry_date<=d),0))
    THEN RAISE EXCEPTION 'OPERATIONS_RECONCILIATION: Register and general ledger differ on %',d; END IF;
  END LOOP;
 END LOOP;
 FOR e IN SELECT * FROM operations_journal_event WHERE ledger_id=l LOOP
  IF (e.source_kind IN ('asset_acquisition','asset_disposal','depreciation','deferred_tax') AND e.seat<>'/assets')
   OR (e.source_kind IN ('inventory','production') AND e.seat<>'/inventory') THEN RAISE EXCEPTION 'OPERATIONS_JOURNAL_SEAT'; END IF;
  IF e.source_kind='opening' AND NOT EXISTS(SELECT 1 FROM operations_finance_setting WHERE ledger_id=l AND id=e.source_id AND seat=e.seat AND connected_on=e.event_date)
   OR e.source_kind='asset_acquisition' AND NOT EXISTS(SELECT 1 FROM fixed_asset WHERE ledger_id=l AND id=e.source_id AND acquired_on=e.event_date)
   OR e.source_kind='asset_disposal' AND NOT EXISTS(SELECT 1 FROM fixed_asset WHERE ledger_id=l AND id=e.source_id AND disposed_on=e.event_date)
   OR e.source_kind='depreciation' AND NOT EXISTS(SELECT 1 FROM asset_depreciation_entry WHERE ledger_id=l AND id=e.source_id AND entry_date=e.event_date)
   OR e.source_kind='deferred_tax' AND NOT EXISTS(SELECT 1 FROM asset_deferred_tax_review WHERE ledger_id=l AND id=e.source_id AND reporting_date=e.event_date)
   OR e.source_kind='inventory' AND NOT EXISTS(SELECT 1 FROM inventory_movement WHERE ledger_id=l AND id=e.source_id AND movement_date=e.event_date AND id=e.movement_id)
   OR e.source_kind='production' AND NOT EXISTS(SELECT 1 FROM production_event WHERE ledger_id=l AND id=e.source_id AND event_date=e.event_date AND movement_id IS NOT DISTINCT FROM e.movement_id)
   THEN RAISE EXCEPTION 'OPERATIONS_JOURNAL_SOURCE'; END IF;
  IF e.entry_id IS NOT NULL THEN
   IF NOT EXISTS(SELECT 1 FROM journal_entry je WHERE je.id=e.entry_id AND je.ledger_id=l AND je.entry_date=e.event_date AND je.status='posted' AND je.source_id=e.source_id
    AND je.source_type=CASE e.source_kind WHEN 'opening' THEN 'operations_opening' WHEN 'asset_acquisition' THEN 'fixed_asset' WHEN 'asset_disposal' THEN 'fixed_asset' WHEN 'depreciation' THEN 'asset_depreciation' WHEN 'deferred_tax' THEN 'asset_deferred_tax' WHEN 'inventory' THEN 'inventory' ELSE 'production' END)
    THEN RAISE EXCEPTION 'OPERATIONS_JOURNAL_IDENTITY: Correct the source, not its journal.'; END IF;
   SELECT jsonb_agg(jsonb_build_object('accountId',account_id,'amount',amount::text) ORDER BY account_id) INTO actual
    FROM (SELECT account_id,sum(amount)::bigint amount FROM journal_line WHERE entry_id=e.entry_id GROUP BY account_id) x;
   SELECT jsonb_agg(jsonb_build_object('accountId',id,'amount',amount::text) ORDER BY id) INTO expected
    FROM (SELECT (v->>'accountId')::uuid id,sum((v->>'amount')::bigint)::bigint amount FROM jsonb_array_elements(e.lines) v GROUP BY (v->>'accountId')::uuid) x;
   IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'OPERATIONS_JOURNAL_LINES'; END IF;
  END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM journal_line jl JOIN journal_entry je ON je.id=jl.entry_id JOIN operations_account m ON m.account_id=jl.account_id
   JOIN operations_account_specs(m.seat) s ON s.key=m.key JOIN operations_finance_setting f ON f.ledger_id=l AND f.seat=m.seat
   WHERE je.ledger_id=l AND s.controlled AND f.connected_on IS NOT NULL AND je.created_at>=f.connected_at
    AND NOT EXISTS(SELECT 1 FROM operations_journal_event linked WHERE linked.ledger_id=l AND linked.entry_id=je.id))
  THEN RAISE EXCEPTION 'OPERATIONS_CONTROL_ACCOUNT: Use the asset or stock source workflow.'; END IF;
 PERFORM operations_validate_production_payroll(l);
END $$;

ALTER FUNCTION operations_validate_ledger(uuid) RENAME TO operations_validate_register;
CREATE FUNCTION operations_validate_ledger(l uuid) RETURNS void LANGUAGE plpgsql STABLE AS $$
BEGIN PERFORM operations_validate_register(l); PERFORM operations_validate_finance(l); END $$;
CREATE FUNCTION operations_finance_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE l uuid;
BEGIN
 IF TG_TABLE_NAME='journal_line' THEN SELECT ledger_id INTO l FROM journal_entry WHERE id=coalesce(NEW.entry_id,OLD.entry_id);
 ELSIF TG_TABLE_NAME='account' THEN
  FOR l IN SELECT id FROM ledger WHERE entity_id=coalesce(NEW.entity_id,OLD.entity_id) LOOP PERFORM operations_validate_finance(l); END LOOP; RETURN NULL;
 ELSIF TG_TABLE_NAME='account_role' OR TG_TABLE_NAME='operations_account' THEN
  FOR l IN SELECT lg.id FROM ledger lg JOIN account a ON a.entity_id=lg.entity_id WHERE a.id=coalesce(NEW.account_id,OLD.account_id) LOOP PERFORM operations_validate_finance(l); END LOOP; RETURN NULL;
 ELSE l:=coalesce(NEW.ledger_id,OLD.ledger_id); END IF;
 IF l IS NOT NULL THEN PERFORM operations_validate_finance(l); END IF;
 RETURN NULL;
END $$;

CREATE FUNCTION operations_validate_production_payroll(l uuid) RETURNS void LANGUAGE plpgsql STABLE AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM production_time t JOIN payroll_employee pe ON pe.id=t.employee_id JOIN ledger lg ON lg.id=t.ledger_id JOIN production_order o ON o.id=t.order_id
   WHERE t.ledger_id=l AND (pe.entity_id<>lg.entity_id OR t.work_date<o.start_date OR t.hours>2400))
  OR EXISTS(SELECT 1 FROM production_time WHERE ledger_id=l AND NOT cancelled GROUP BY employee_id,work_date HAVING sum(hours)>2400)
  THEN RAISE EXCEPTION 'PRODUCTION_TIME_SCOPE'; END IF;
 IF EXISTS(SELECT 1 FROM production_payroll_allocation a JOIN production_time t ON t.id=a.time_id JOIN pay_stub s ON s.id=a.pay_stub_id
   JOIN pay_run p ON p.id=s.pay_run_id JOIN journal_entry j ON j.id=p.entry_id JOIN production_event e ON e.id=a.event_id
   WHERE a.ledger_id=l AND (a.ledger_id<>t.ledger_id OR a.ledger_id<>p.ledger_id OR t.employee_id<>s.employee_id
    OR e.order_id<>t.order_id OR e.kind<>'conversion_cost' OR e.quantity<>0 OR e.item_id IS NOT NULL OR e.cost<>a.gross_cost+a.employer_cost
    OR a.hours<>t.hours OR p.period_start IS NULL OR p.period_end IS NULL OR t.work_date NOT BETWEEN p.period_start AND p.period_end
    OR e.event_date<p.pay_date OR e.event_date<t.work_date
    OR NOT EXISTS(SELECT 1 FROM journal_line jl JOIN account_role ar ON ar.account_id=jl.account_id AND ar.role='employee_benefits_expense'
     WHERE jl.entry_id=p.entry_id AND jl.amount>0 AND jl.account_id=(a.snapshot->>'expenseAccountId')::uuid)
    OR NOT EXISTS(SELECT 1 FROM production_payroll_reversal r WHERE r.allocation_id=a.id) AND (t.cancelled OR j.status<>'posted')))
  THEN RAISE EXCEPTION 'PRODUCTION_PAYROLL_SOURCE: Preserve the posted stub, employee, pay period, actual expense and cost source.'; END IF;
 IF EXISTS(SELECT 1 FROM production_payroll_allocation a WHERE a.ledger_id=l AND NOT EXISTS(SELECT 1 FROM production_payroll_reversal r WHERE r.allocation_id=a.id) GROUP BY time_id HAVING count(*)>1)
  THEN RAISE EXCEPTION 'PRODUCTION_TIME_DUPLICATE_ALLOCATION'; END IF;
 IF EXISTS(SELECT 1 FROM production_payroll_allocation a JOIN pay_stub s ON s.id=a.pay_stub_id WHERE a.ledger_id=l
   AND NOT EXISTS(SELECT 1 FROM production_payroll_reversal r WHERE r.allocation_id=a.id)
   GROUP BY s.id HAVING sum(a.hours)>s.hours OR s.hours<=0
    OR sum(a.gross_cost)>round((s.gross-s.bonus)::numeric*sum(a.hours)/nullif(s.hours,0))
    OR sum(a.employer_cost)>round(round((s.employer_cpp+s.employer_cpp2+s.employer_ei)::numeric*(s.gross-s.bonus)/nullif(s.gross,0))*sum(a.hours)/nullif(s.hours,0)))
  THEN RAISE EXCEPTION 'PRODUCTION_PAYROLL_CEILING'; END IF;
 IF EXISTS(SELECT 1 FROM production_payroll_allocation a JOIN production_event e ON e.id=a.event_id
  JOIN operations_journal_event j ON j.ledger_id=a.ledger_id AND j.source_kind='production' AND j.source_id=e.id
  WHERE a.ledger_id=l AND coalesce((SELECT sum((v->>'amount')::bigint) FROM jsonb_array_elements(j.lines) v
   WHERE (v->>'accountId')::uuid=(a.snapshot->>'expenseAccountId')::uuid),0)<>-e.cost)
  THEN RAISE EXCEPTION 'PRODUCTION_PAYROLL_EXPENSE'; END IF;
 IF EXISTS(SELECT 1 FROM production_payroll_reversal r JOIN production_payroll_allocation a ON a.id=r.allocation_id
   JOIN production_event src ON src.id=a.event_id JOIN production_event e ON e.id=r.event_id
   WHERE r.ledger_id=l AND (e.order_id<>src.order_id OR e.kind<>'labour_return' OR e.quantity<>0 OR e.item_id IS NOT NULL
    OR e.cost<>src.cost OR (e.event_date,e.created_at,e.id)<(src.event_date,src.created_at,src.id)
    OR EXISTS(SELECT 1 FROM production_event c WHERE c.order_id=src.order_id AND c.kind IN ('completion','loss') AND (c.event_date,c.created_at,c.id)>(src.event_date,src.created_at,src.id) AND (c.event_date,c.created_at,c.id)<=(e.event_date,e.created_at,e.id))))
  OR EXISTS(SELECT 1 FROM production_event e WHERE e.ledger_id=l AND e.kind='labour_return' AND NOT EXISTS(SELECT 1 FROM production_payroll_reversal r WHERE r.event_id=e.id))
  THEN RAISE EXCEPTION 'PRODUCTION_LABOUR_CONSUMED'; END IF;
 IF EXISTS(SELECT 1 FROM production_event c JOIN production_time t ON t.order_id=c.order_id AND NOT t.cancelled AND t.work_date<=c.event_date
   WHERE c.ledger_id=l AND c.kind='completion' AND NOT EXISTS(SELECT 1 FROM production_payroll_allocation a JOIN production_event e ON e.id=a.event_id
    WHERE a.time_id=t.id AND (e.event_date,e.created_at,e.id)<=(c.event_date,c.created_at,c.id)
     AND NOT EXISTS(SELECT 1 FROM production_payroll_reversal r JOIN production_event v ON v.id=r.event_id WHERE r.allocation_id=a.id AND (v.event_date,v.created_at,v.id)<=(c.event_date,c.created_at,c.id))))
  THEN RAISE EXCEPTION 'PRODUCTION_LABOUR_PENDING'; END IF;
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['production_time','production_payroll_allocation','production_payroll_reversal','pay_run','pay_stub'] LOOP
  IF t IN ('pay_run','pay_stub') THEN CONTINUE; END IF;
  EXECUTE format('CREATE CONSTRAINT TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION operations_finance_check()',t||'_finance_check',t);
 END LOOP;
END $$;
CREATE FUNCTION operations_payroll_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE l uuid;
BEGIN
 IF TG_TABLE_NAME='pay_stub' THEN SELECT ledger_id INTO l FROM pay_run WHERE id=coalesce(NEW.pay_run_id,OLD.pay_run_id);
 ELSE l:=coalesce(NEW.ledger_id,OLD.ledger_id); END IF;
 IF l IS NOT NULL THEN PERFORM operations_validate_production_payroll(l); END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER pay_run_operations_check AFTER INSERT OR UPDATE OR DELETE ON pay_run DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION operations_payroll_check();
CREATE CONSTRAINT TRIGGER pay_stub_operations_check AFTER INSERT OR UPDATE OR DELETE ON pay_stub DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION operations_payroll_check();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['operations_finance_setting','asset_ledger_assignment','operations_journal_event','fixed_asset','asset_depreciation_entry','asset_deferred_tax_review','inventory_movement','production_event','journal_entry','journal_line','account','account_role','operations_account'] LOOP
  EXECUTE format('CREATE CONSTRAINT TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION operations_finance_check()',t||'_finance_check',t);
 END LOOP;
END $$;
