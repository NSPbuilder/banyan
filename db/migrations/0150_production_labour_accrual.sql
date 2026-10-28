-- Daily manufacturing labour is an estimate, separate from statutory payroll.
ALTER TABLE production_event DROP CONSTRAINT production_event_kind_check;
ALTER TABLE production_event ADD CONSTRAINT production_event_kind_check CHECK(kind IN
 ('material_issue','material_return','conversion_cost','completion','loss','cancel','labour_return','labour_accrual','labour_settlement','labour_adjustment','labour_accrual_return'));
DO $$ DECLARE n text; BEGIN
 SELECT conname INTO STRICT n FROM pg_constraint WHERE conrelid='production_event'::regclass AND contype='c' AND pg_get_constraintdef(oid)='CHECK ((cost >= 0))';
 EXECUTE format('ALTER TABLE production_event DROP CONSTRAINT %I',n);
END $$;
ALTER TABLE production_event ADD CONSTRAINT production_event_signed_cost CHECK(cost>=0 OR kind='labour_adjustment');
ALTER TABLE inventory_cost_layer ADD COLUMN transfer_source_layer_id uuid;
ALTER TABLE inventory_cost_layer ADD CONSTRAINT labour_fk_1 FOREIGN KEY(ledger_id,transfer_source_layer_id) REFERENCES inventory_cost_layer(ledger_id,id);

ALTER FUNCTION operations_account_specs(text) RENAME TO operations_account_specs_base;
CREATE FUNCTION operations_account_specs(p_seat text) RETURNS TABLE
 (key text,code text,label text,kind text,balance text,role text,function_role text,controlled boolean)
 LANGUAGE sql IMMUTABLE AS $$
 SELECT * FROM operations_account_specs_base(p_seat)
 UNION ALL SELECT 'labour_accrual','2624-LAB','Accrued production labour','liability','credit','payroll_liabilities',NULL,true WHERE p_seat='/inventory'
$$;
-- Existing initialized modules get the additional controlled account in this migration.
DO $$ DECLARE e uuid; BEGIN
 FOR e IN SELECT DISTINCT entity_id FROM operations_account WHERE seat='/inventory' LOOP
  PERFORM ensure_operations_accounts(e,'/inventory','migration:0150');
 END LOOP;
END $$;

CREATE TABLE production_labour_period (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),ledger_id uuid NOT NULL REFERENCES ledger(id),employee_id uuid NOT NULL REFERENCES payroll_employee(id),
 period_start date NOT NULL,period_end date NOT NULL,pay_date date NOT NULL,wage_basis text NOT NULL CONSTRAINT lab_check1 CHECK(wage_basis IN ('hourly','fixed')),
 hourly_rate bigint NOT NULL CONSTRAINT lab_check2 CHECK(hourly_rate>=0),paid_hours bigint NOT NULL CONSTRAINT lab_check3 CHECK(paid_hours>0),normal_hours bigint NOT NULL CONSTRAINT lab_check4 CHECK(normal_hours>0),
 gross bigint NOT NULL CONSTRAINT lab_check5 CHECK(gross>0),employer_cost bigint NOT NULL CONSTRAINT lab_check6 CHECK(employer_cost>=0),snapshot jsonb NOT NULL,note text NOT NULL,
 request_key uuid NOT NULL,request_hash text NOT NULL,created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT lab_unique1 UNIQUE(ledger_id,id),CONSTRAINT lab_unique2 UNIQUE(ledger_id,request_key),CONSTRAINT lab_check7 CHECK(period_start<=period_end AND pay_date>=period_end)
);
CREATE TABLE production_labour_accrual (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),ledger_id uuid NOT NULL REFERENCES ledger(id),period_id uuid NOT NULL,time_id uuid NOT NULL,event_id uuid NOT NULL,
 gross_cost bigint NOT NULL CONSTRAINT lab_check8 CHECK(gross_cost>=0),employer_cost bigint NOT NULL CONSTRAINT lab_check9 CHECK(employer_cost>=0),
 request_key uuid NOT NULL,request_hash text NOT NULL,created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT lab_unique3 UNIQUE(ledger_id,id),CONSTRAINT lab_unique4 UNIQUE(ledger_id,time_id),CONSTRAINT lab_unique5 UNIQUE(ledger_id,event_id),CONSTRAINT lab_unique6 UNIQUE(ledger_id,request_key),
 CONSTRAINT labour_fk_2 FOREIGN KEY(ledger_id,period_id) REFERENCES production_labour_period(ledger_id,id),CONSTRAINT labour_fk_3 FOREIGN KEY(ledger_id,time_id) REFERENCES production_time(ledger_id,id),
 CONSTRAINT labour_fk_4 FOREIGN KEY(ledger_id,event_id) REFERENCES production_event(ledger_id,id)
);
CREATE TABLE production_labour_accrual_reversal (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),ledger_id uuid NOT NULL REFERENCES ledger(id),accrual_id uuid NOT NULL,event_id uuid NOT NULL,
 note text NOT NULL CHECK(length(btrim(note))>0),request_key uuid NOT NULL,request_hash text NOT NULL,created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT lab_ar_id UNIQUE(ledger_id,id),CONSTRAINT lab_ar_source UNIQUE(accrual_id),CONSTRAINT lab_ar_event UNIQUE(event_id),CONSTRAINT lab_ar_request UNIQUE(ledger_id,request_key),
 CONSTRAINT lab_ar_accrual_fk FOREIGN KEY(ledger_id,accrual_id) REFERENCES production_labour_accrual(ledger_id,id),
 CONSTRAINT lab_ar_event_fk FOREIGN KEY(ledger_id,event_id) REFERENCES production_event(ledger_id,id)
);
CREATE TABLE production_labour_settlement (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),ledger_id uuid NOT NULL REFERENCES ledger(id),period_id uuid NOT NULL,pay_stub_id uuid NOT NULL REFERENCES pay_stub(id),event_id uuid NOT NULL,
 reverse_of uuid,eligible_gross bigint NOT NULL CONSTRAINT lab_check10 CHECK(eligible_gross>=0),normal_hours bigint NOT NULL CONSTRAINT lab_check11 CHECK(normal_hours>0),
 estimated_cost bigint NOT NULL CONSTRAINT lab_check12 CHECK(estimated_cost>=0),actual_cost bigint NOT NULL CONSTRAINT lab_check13 CHECK(actual_cost>=0),expense_account_id uuid NOT NULL REFERENCES account(id),
 snapshot jsonb NOT NULL,note text NOT NULL,request_key uuid NOT NULL,request_hash text NOT NULL,created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT lab_unique7 UNIQUE(ledger_id,id),CONSTRAINT lab_unique8 UNIQUE(ledger_id,event_id),CONSTRAINT lab_unique9 UNIQUE(ledger_id,request_key),CONSTRAINT lab_unique10 UNIQUE(reverse_of),
 CONSTRAINT labour_fk_5 FOREIGN KEY(ledger_id,period_id) REFERENCES production_labour_period(ledger_id,id),CONSTRAINT labour_fk_6 FOREIGN KEY(ledger_id,event_id) REFERENCES production_event(ledger_id,id),
 CONSTRAINT labour_fk_7 FOREIGN KEY(ledger_id,reverse_of) REFERENCES production_labour_settlement(ledger_id,id)
);
CREATE TABLE production_labour_settlement_line (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),ledger_id uuid NOT NULL REFERENCES ledger(id),settlement_id uuid NOT NULL,accrual_id uuid NOT NULL,
 gross_cost bigint NOT NULL CONSTRAINT lab_check14 CHECK(gross_cost>=0),employer_cost bigint NOT NULL CONSTRAINT lab_check15 CHECK(employer_cost>=0),
 CONSTRAINT lab_unique11 UNIQUE(ledger_id,id),CONSTRAINT lab_unique12 UNIQUE(settlement_id,accrual_id),CONSTRAINT labour_fk_8 FOREIGN KEY(ledger_id,settlement_id) REFERENCES production_labour_settlement(ledger_id,id),
 CONSTRAINT labour_fk_9 FOREIGN KEY(ledger_id,accrual_id) REFERENCES production_labour_accrual(ledger_id,id)
);
CREATE TABLE production_labour_cost_adjustment (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),ledger_id uuid NOT NULL REFERENCES ledger(id),settlement_id uuid NOT NULL,
 target_kind text NOT NULL CONSTRAINT lab_check16 CHECK(target_kind IN ('wip','stock','expense')),order_id uuid,layer_id uuid,account_id uuid NOT NULL REFERENCES account(id),
 amount bigint NOT NULL,basis_quantity bigint,cost_after bigint,event_id uuid,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),CONSTRAINT lab_unique13 UNIQUE(ledger_id,id),
 CONSTRAINT labour_fk_10 FOREIGN KEY(ledger_id,settlement_id) REFERENCES production_labour_settlement(ledger_id,id),
 CONSTRAINT labour_fk_11 FOREIGN KEY(ledger_id,order_id) REFERENCES production_order(ledger_id,id),CONSTRAINT labour_fk_12 FOREIGN KEY(ledger_id,layer_id) REFERENCES inventory_cost_layer(ledger_id,id),
 CONSTRAINT labour_fk_13 FOREIGN KEY(ledger_id,event_id) REFERENCES production_event(ledger_id,id),
 CONSTRAINT lab_check17 CHECK((target_kind='wip')=(order_id IS NOT NULL)),CONSTRAINT lab_check18 CHECK((target_kind='stock')=(layer_id IS NOT NULL)),
 CONSTRAINT lab_check19 CHECK((target_kind='wip')=(event_id IS NOT NULL)),CONSTRAINT lab_check20 CHECK((target_kind='stock')=(basis_quantity IS NOT NULL AND cost_after IS NOT NULL)),
 CONSTRAINT lab_check21 CHECK(target_kind<>'stock' OR basis_quantity>0 AND cost_after>=0)
);
CREATE INDEX production_labour_layer_revision ON production_labour_cost_adjustment(layer_id,created_at DESC,id DESC) WHERE target_kind='stock';
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['production_labour_period','production_labour_accrual','production_labour_accrual_reversal','production_labour_settlement','production_labour_settlement_line','production_labour_cost_adjustment'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION inventory_write_guard()',t||'_door',t);
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION operations_history_immutable()',t||'_immutable',t);
  EXECUTE format('CREATE TRIGGER %I AFTER INSERT ON %I FOR EACH ROW EXECUTE FUNCTION operations_audit()',t||'_audit',t);
  EXECUTE format('CREATE CONSTRAINT TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION operations_finance_check()',t||'_check',t);
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION operations_validate_register(l uuid) RETURNS void LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM (
      SELECT item_id,warehouse_id,sum(q) FROM (
        SELECT item_id,warehouse_id,quantity q FROM inventory_stock WHERE ledger_id=l
        UNION ALL SELECT item_id,warehouse_id,-remaining_quantity FROM inventory_cost_layer WHERE ledger_id=l
      ) b GROUP BY item_id,warehouse_id HAVING sum(q)<>0
    ) b)
    OR EXISTS(SELECT 1 FROM inventory_stock s WHERE s.ledger_id=l AND s.quantity<>(SELECT coalesce(sum(quantity),0) FROM inventory_stock_change WHERE stock_id=s.id))
    OR EXISTS(SELECT 1 FROM inventory_cost_layer c WHERE c.ledger_id=l AND
      (c.remaining_quantity<>c.quantity-(SELECT coalesce(sum(quantity),0) FROM inventory_cost_allocation WHERE layer_id=c.id)
       OR c.remaining_cost<>c.cost+(SELECT coalesce(sum(amount),0) FROM inventory_cost_revaluation WHERE layer_id=c.id)+(SELECT coalesce(sum(amount),0) FROM production_labour_cost_adjustment WHERE layer_id=c.id)-(SELECT coalesce(sum(cost),0) FROM inventory_cost_allocation WHERE layer_id=c.id)))
    OR EXISTS(SELECT 1 FROM inventory_cost_revaluation r JOIN inventory_cost_layer c ON c.id=r.layer_id WHERE r.ledger_id=l GROUP BY r.movement_id,c.warehouse_id HAVING sum(r.amount)<>0)
    OR EXISTS(SELECT 1 FROM inventory_stock s JOIN inventory_item i ON i.id=s.item_id WHERE s.ledger_id=l AND (i.track_batches<>(s.batch<>'') OR i.track_serials<>(s.serial<>''))) THEN
      RAISE EXCEPTION 'INVENTORY_REGISTER_INCONSISTENT: Stock and costs must reconcile to movement history.';
  END IF;
  IF EXISTS(SELECT 1 FROM fixed_asset_activity x JOIN fixed_asset a ON a.id=x.asset_id WHERE x.ledger_id=l AND (x.activity_date<a.acquired_on OR x.activity_date>a.disposed_on)) THEN RAISE EXCEPTION 'ASSET_ACTIVITY_DATES_INCONSISTENT'; END IF;
  IF EXISTS(SELECT 1 FROM production_order o WHERE o.ledger_id=l AND (
    (SELECT coalesce(sum(CASE WHEN kind IN ('material_issue','conversion_cost','labour_accrual','labour_adjustment') THEN cost ELSE -cost END),0) FROM production_event WHERE order_id=o.id)<0
    OR (SELECT coalesce(sum(quantity),0) FROM production_event WHERE order_id=o.id AND kind='completion')>o.planned_quantity
    OR o.status<>'in_progress' AND (SELECT coalesce(sum(CASE WHEN kind IN ('material_issue','conversion_cost','labour_accrual','labour_adjustment') THEN cost ELSE -cost END),0) FROM production_event WHERE order_id=o.id)<>0)) THEN RAISE EXCEPTION 'PRODUCTION_REGISTER_INCONSISTENT'; END IF;
  IF EXISTS(SELECT 1 FROM inventory_cost_revaluation r JOIN inventory_cost_layer c ON c.id=r.layer_id JOIN inventory_movement m ON m.id=r.movement_id WHERE r.ledger_id=l AND (m.cost_method<>'moving_average' OR c.item_id<>m.item_id OR c.warehouse_id IS DISTINCT FROM m.from_warehouse_id AND c.warehouse_id IS DISTINCT FROM m.to_warehouse_id)) THEN RAISE EXCEPTION 'AVERAGE_COST_REVALUATION_INVALID'; END IF;
  IF EXISTS(SELECT 1 FROM production_order o WHERE o.ledger_id=l AND NOT EXISTS(SELECT 1 FROM production_order_line WHERE order_id=o.id))
    OR EXISTS(SELECT 1 FROM production_order_line x JOIN production_order o ON o.id=x.order_id WHERE x.ledger_id=l AND x.item_id=o.output_item_id)
    OR EXISTS(SELECT 1 FROM production_event e JOIN production_order o ON o.id=e.order_id WHERE e.ledger_id=l AND e.event_date<o.start_date)
    OR EXISTS(SELECT 1 FROM production_event e JOIN production_event src ON src.id=e.source_event_id WHERE e.ledger_id=l AND (src.kind<>'material_issue' OR src.order_id<>e.order_id OR src.item_id<>e.item_id))
    OR EXISTS(SELECT 1 FROM production_event src WHERE src.ledger_id=l AND src.kind='material_issue' AND (SELECT coalesce(sum(quantity),0) FROM production_event WHERE source_event_id=src.id)>src.quantity)
    OR EXISTS(SELECT 1 FROM (SELECT sum(CASE WHEN kind IN ('material_issue','conversion_cost','labour_accrual','labour_adjustment') THEN cost ELSE -cost END) OVER(PARTITION BY order_id ORDER BY event_date,created_at,id) AS running FROM production_event WHERE ledger_id=l) x WHERE running<0)
    OR EXISTS(SELECT 1 FROM (SELECT sum(CASE WHEN kind='material_issue' THEN quantity ELSE -quantity END) OVER(PARTITION BY order_id,item_id ORDER BY event_date,created_at,id) AS running FROM production_event WHERE ledger_id=l AND kind IN ('material_issue','material_return')) x WHERE running<0) THEN RAISE EXCEPTION 'PRODUCTION_HISTORY_INCONSISTENT'; END IF;
  IF EXISTS(SELECT 1 FROM production_order o WHERE o.ledger_id=l AND (o.status='completed' AND (SELECT coalesce(sum(quantity),0) FROM production_event WHERE order_id=o.id AND kind='completion')<>o.planned_quantity OR o.status='in_progress' AND (SELECT coalesce(sum(quantity),0) FROM production_event WHERE order_id=o.id AND kind='completion')>=o.planned_quantity OR o.status='cancelled' AND EXISTS(SELECT 1 FROM production_event WHERE order_id=o.id AND kind='completion')))
    OR EXISTS(SELECT 1 FROM production_order_line x JOIN production_order o ON o.id=x.order_id WHERE x.ledger_id=l AND o.status='cancelled' AND (SELECT coalesce(sum(CASE WHEN kind='material_issue' THEN quantity ELSE -quantity END),0) FROM production_event WHERE order_id=o.id AND item_id=x.item_id AND kind IN ('material_issue','material_return'))<>0)
    OR EXISTS(SELECT 1 FROM production_event e JOIN production_order o ON o.id=e.order_id WHERE e.ledger_id=l AND (e.kind='completion' AND e.item_id<>o.output_item_id OR e.kind IN ('material_issue','material_return') AND NOT EXISTS(SELECT 1 FROM production_order_line WHERE order_id=e.order_id AND item_id=e.item_id) OR e.kind IN ('conversion_cost','loss','cancel') AND (e.quantity<>0 OR e.item_id IS NOT NULL) OR e.kind='cancel' AND e.cost<>0)) THEN RAISE EXCEPTION 'PRODUCTION_STATUS_INCONSISTENT'; END IF;
  IF EXISTS(SELECT 1 FROM production_event e JOIN production_order o ON o.id=e.order_id JOIN production_order_line x ON x.order_id=o.id WHERE e.ledger_id=l AND e.kind='completion' AND
    (SELECT coalesce(sum(CASE WHEN kind='material_issue' THEN quantity ELSE -quantity END),0) FROM production_event m WHERE m.order_id=o.id AND m.item_id=x.item_id AND m.kind IN ('material_issue','material_return') AND (m.event_date,m.created_at,m.id)<=(e.event_date,e.created_at,e.id))
    <ceil(x.quantity::numeric*(SELECT coalesce(sum(quantity),0) FROM production_event c WHERE c.order_id=o.id AND c.kind='completion' AND (c.event_date,c.created_at,c.id)<=(e.event_date,e.created_at,e.id))/o.planned_quantity)) THEN RAISE EXCEPTION 'PRODUCTION_MATERIALS_INCONSISTENT'; END IF;
  IF EXISTS(SELECT 1 FROM production_event e JOIN inventory_movement m ON m.id=e.movement_id WHERE e.ledger_id=l AND
    (e.item_id<>m.item_id OR e.quantity<>m.quantity OR e.cost<>m.cost OR e.kind='material_issue' AND m.kind<>'issue' OR e.kind IN ('material_return','completion') AND m.kind<>'adjust_in')) THEN RAISE EXCEPTION 'PRODUCTION_MOVEMENT_INCONSISTENT'; END IF;
END $$;

CREATE OR REPLACE FUNCTION operations_financial_targets(p_ledger uuid,p_seat text,p_date date)
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
  UNION ALL SELECT 'wip',coalesce(sum(CASE WHEN kind IN ('material_issue','conversion_cost','labour_accrual','labour_adjustment') THEN cost ELSE -cost END),0)::numeric
   FROM production_event WHERE ledger_id=p_ledger AND event_date<=p_date AND p_seat='/inventory'
  UNION ALL SELECT CASE i.kind WHEN 'work_in_progress' THEN 'wip' ELSE i.kind END,sum(x.amount)::numeric
   FROM production_labour_cost_adjustment x JOIN production_labour_settlement st ON st.id=x.settlement_id JOIN production_event e ON e.id=st.event_id
    JOIN inventory_cost_layer c ON c.id=x.layer_id JOIN inventory_item i ON i.id=c.item_id
   WHERE x.ledger_id=p_ledger AND e.event_date<=p_date AND p_seat='/inventory' GROUP BY i.kind
  UNION ALL SELECT 'labour_accrual',-
   (coalesce((SELECT sum(e.cost) FROM production_labour_accrual a JOIN production_event e ON e.id=a.event_id WHERE a.ledger_id=p_ledger AND e.event_date<=p_date),0)
    -coalesce((SELECT sum(e.cost) FROM production_labour_accrual_reversal r JOIN production_event e ON e.id=r.event_id WHERE r.ledger_id=p_ledger AND e.event_date<=p_date),0)
    -coalesce((SELECT sum(CASE WHEN st.reverse_of IS NULL THEN st.estimated_cost ELSE -st.estimated_cost END) FROM production_labour_settlement st JOIN production_event e ON e.id=st.event_id WHERE st.ledger_id=p_ledger AND e.event_date<=p_date),0))::numeric WHERE p_seat='/inventory'
 ) SELECT s.key,coalesce(sum(a.amount),0)::numeric FROM operations_account_specs(p_seat) s
 LEFT JOIN amounts a ON a.key=s.key WHERE s.controlled GROUP BY s.key
$$;

CREATE OR REPLACE FUNCTION operations_validate_production_payroll(l uuid) RETURNS void LANGUAGE plpgsql STABLE AS $$
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
   WHERE c.ledger_id=l AND c.kind='completion' AND NOT EXISTS(SELECT 1 FROM production_labour_accrual ac JOIN production_event ae ON ae.id=ac.event_id WHERE ac.time_id=t.id AND NOT EXISTS(SELECT 1 FROM production_labour_accrual_reversal v JOIN production_event ve ON ve.id=v.event_id WHERE v.accrual_id=ac.id AND (ve.event_date,ve.created_at,ve.id)<=(c.event_date,c.created_at,c.id)) AND (ae.event_date,ae.created_at,ae.id)<=(c.event_date,c.created_at,c.id)) AND NOT EXISTS(SELECT 1 FROM production_payroll_allocation a JOIN production_event e ON e.id=a.event_id
    WHERE a.time_id=t.id AND (e.event_date,e.created_at,e.id)<=(c.event_date,c.created_at,c.id)
     AND NOT EXISTS(SELECT 1 FROM production_payroll_reversal r JOIN production_event v ON v.id=r.event_id WHERE r.allocation_id=a.id AND (v.event_date,v.created_at,v.id)<=(c.event_date,c.created_at,c.id))))
  THEN RAISE EXCEPTION 'PRODUCTION_LABOUR_PENDING'; END IF;
 PERFORM operations_validate_labour_accrual(l);
END $$;

CREATE FUNCTION operations_validate_labour_accrual(l uuid) RETURNS void LANGUAGE plpgsql STABLE AS $$
DECLARE src uuid;
BEGIN
 FOR src IN SELECT DISTINCT e.source_event_id FROM production_event e WHERE e.ledger_id=l AND e.kind='material_return' AND e.created_at>=(SELECT min(created_at) FROM production_labour_accrual WHERE ledger_id=l) LOOP
  PERFORM production_material_source_remaining(src,'9999-12-31'::date);
 END LOOP;
 IF EXISTS(SELECT 1 FROM production_labour_cost_adjustment x JOIN production_labour_settlement st ON st.id=x.settlement_id JOIN production_event se ON se.id=st.event_id JOIN production_event r ON r.order_id=x.order_id AND r.kind='material_return' WHERE x.ledger_id=l AND st.reverse_of IS NULL AND NOT EXISTS(SELECT 1 FROM production_labour_settlement v WHERE v.reverse_of=st.id) AND (r.event_date,r.created_at,r.id)>(se.event_date,se.created_at,se.id)) THEN RAISE EXCEPTION 'LABOUR_RETURN_SETTLEMENT'; END IF;
 IF EXISTS(SELECT 1 FROM production_labour_period p JOIN payroll_employee pe ON pe.id=p.employee_id JOIN ledger lg ON lg.id=p.ledger_id WHERE p.ledger_id=l AND (pe.entity_id<>lg.entity_id OR lg.currency<>'CAD'))
 OR EXISTS(SELECT 1 FROM production_labour_period p JOIN production_labour_period q ON q.ledger_id=p.ledger_id AND q.employee_id=p.employee_id AND q.id>p.id AND q.period_start<=p.period_end AND q.period_end>=p.period_start WHERE p.ledger_id=l)
 THEN RAISE EXCEPTION 'LABOUR_PERIOD_SCOPE'; END IF;
 IF EXISTS(SELECT 1 FROM production_labour_accrual a JOIN production_labour_period p ON p.id=a.period_id JOIN production_time t ON t.id=a.time_id JOIN production_event e ON e.id=a.event_id
  WHERE a.ledger_id=l AND (p.ledger_id<>l OR t.ledger_id<>l OR e.ledger_id<>l OR t.cancelled AND NOT EXISTS(SELECT 1 FROM production_labour_accrual_reversal v WHERE v.accrual_id=a.id) OR t.employee_id<>p.employee_id OR t.work_date NOT BETWEEN p.period_start AND p.period_end
   OR e.order_id<>t.order_id OR e.event_date<t.work_date OR e.kind<>'labour_accrual' OR e.cost<>a.gross_cost+a.employer_cost OR e.quantity<>0 OR e.item_id IS NOT NULL
   OR NOT EXISTS(SELECT 1 FROM production_labour_accrual_reversal rv WHERE rv.accrual_id=a.id) AND EXISTS(SELECT 1 FROM production_payroll_allocation x WHERE x.time_id=t.id AND NOT EXISTS(SELECT 1 FROM production_payroll_reversal v WHERE v.allocation_id=x.id))))
 OR EXISTS(SELECT 1 FROM production_event e WHERE e.ledger_id=l AND e.kind='labour_accrual' AND NOT EXISTS(SELECT 1 FROM production_labour_accrual a WHERE a.event_id=e.id))
 THEN RAISE EXCEPTION 'LABOUR_ACCRUAL_SOURCE'; END IF;
 IF EXISTS(SELECT 1 FROM production_labour_accrual a JOIN production_labour_period p ON p.id=a.period_id JOIN production_time t ON t.id=a.time_id WHERE a.ledger_id=l AND NOT EXISTS(SELECT 1 FROM production_labour_accrual_reversal v WHERE v.accrual_id=a.id) GROUP BY p.id
  HAVING sum(t.hours)>p.normal_hours)
 OR EXISTS(SELECT 1 FROM production_labour_accrual a JOIN production_labour_period p ON p.id=a.period_id JOIN production_time t ON t.id=a.time_id WHERE a.ledger_id=l AND
  (a.gross_cost<>round(p.gross::numeric*t.hours/p.normal_hours) OR a.employer_cost<>round(p.employer_cost::numeric*t.hours/p.normal_hours)))
 THEN RAISE EXCEPTION 'LABOUR_ACCRUAL_CEILING'; END IF;
 IF EXISTS(SELECT 1 FROM production_labour_accrual_reversal v JOIN production_labour_accrual a ON a.id=v.accrual_id JOIN production_event src ON src.id=a.event_id JOIN production_event e ON e.id=v.event_id WHERE v.ledger_id=l AND
  (a.ledger_id<>l OR e.ledger_id<>l OR e.order_id<>src.order_id OR e.kind<>'labour_accrual_return' OR e.cost<>src.cost OR e.quantity<>0 OR e.item_id IS NOT NULL OR (e.event_date,e.created_at,e.id)<(src.event_date,src.created_at,src.id)
   OR EXISTS(SELECT 1 FROM production_event c WHERE c.order_id=src.order_id AND c.kind IN ('completion','loss') AND (c.event_date,c.created_at,c.id)>(src.event_date,src.created_at,src.id) AND (c.event_date,c.created_at,c.id)<=(e.event_date,e.created_at,e.id))
   OR EXISTS(SELECT 1 FROM production_labour_settlement_line sl JOIN production_labour_settlement st ON st.id=sl.settlement_id WHERE sl.accrual_id=a.id AND st.reverse_of IS NULL AND NOT EXISTS(SELECT 1 FROM production_labour_settlement r WHERE r.reverse_of=st.id))))
 OR EXISTS(SELECT 1 FROM production_event e WHERE e.ledger_id=l AND e.kind='labour_accrual_return' AND NOT EXISTS(SELECT 1 FROM production_labour_accrual_reversal v WHERE v.event_id=e.id))
 THEN RAISE EXCEPTION 'LABOUR_ACCRUAL_REVERSAL'; END IF;
 IF EXISTS(SELECT 1 FROM production_labour_settlement st JOIN production_labour_period p ON p.id=st.period_id JOIN pay_stub s ON s.id=st.pay_stub_id JOIN pay_run r ON r.id=s.pay_run_id JOIN journal_entry j ON j.id=r.entry_id JOIN production_event e ON e.id=st.event_id
  WHERE st.ledger_id=l AND (p.ledger_id<>l OR r.ledger_id<>l OR e.ledger_id<>l OR p.employee_id<>s.employee_id OR r.period_start IS DISTINCT FROM p.period_start OR r.period_end IS DISTINCT FROM p.period_end
   OR e.kind<>'labour_settlement' OR e.cost<>0 OR e.quantity<>0 OR e.item_id IS NOT NULL OR e.event_date<r.pay_date OR st.eligible_gross>s.gross-s.bonus
   OR NOT EXISTS(SELECT 1 FROM journal_line jl JOIN account_role ar ON ar.account_id=jl.account_id AND ar.role='employee_benefits_expense' WHERE jl.entry_id=r.entry_id AND jl.amount>0 AND jl.account_id=st.expense_account_id)
   OR st.reverse_of IS NULL AND NOT EXISTS(SELECT 1 FROM production_labour_settlement v WHERE v.reverse_of=st.id) AND j.status<>'posted'))
 OR EXISTS(SELECT 1 FROM production_event e WHERE e.ledger_id=l AND e.kind='labour_settlement' AND NOT EXISTS(SELECT 1 FROM production_labour_settlement st WHERE st.event_id=e.id))
 THEN RAISE EXCEPTION 'LABOUR_SETTLEMENT_SOURCE'; END IF;
 IF EXISTS(SELECT 1 FROM production_labour_settlement st WHERE st.ledger_id=l AND st.reverse_of IS NULL AND NOT EXISTS(SELECT 1 FROM production_labour_settlement v WHERE v.reverse_of=st.id) GROUP BY period_id HAVING count(*)>1)
 OR EXISTS(SELECT 1 FROM production_labour_settlement st WHERE st.ledger_id=l AND st.reverse_of IS NULL AND NOT EXISTS(SELECT 1 FROM production_labour_settlement v WHERE v.reverse_of=st.id) GROUP BY pay_stub_id HAVING count(*)>1)
 OR EXISTS(SELECT 1 FROM production_labour_settlement st JOIN production_payroll_allocation a ON a.pay_stub_id=st.pay_stub_id WHERE st.ledger_id=l AND st.reverse_of IS NULL AND NOT EXISTS(SELECT 1 FROM production_labour_settlement v WHERE v.reverse_of=st.id) AND NOT EXISTS(SELECT 1 FROM production_payroll_reversal v WHERE v.allocation_id=a.id))
 THEN RAISE EXCEPTION 'LABOUR_DUPLICATE_SETTLEMENT'; END IF;
 IF EXISTS(SELECT 1 FROM production_labour_settlement_line x JOIN production_labour_settlement st ON st.id=x.settlement_id JOIN production_labour_accrual a ON a.id=x.accrual_id WHERE x.ledger_id=l AND (st.ledger_id<>l OR a.ledger_id<>l OR a.period_id<>st.period_id))
 OR EXISTS(SELECT 1 FROM production_labour_settlement st JOIN pay_stub s ON s.id=st.pay_stub_id WHERE st.ledger_id=l AND (
  st.estimated_cost<>(SELECT coalesce(sum(a.gross_cost+a.employer_cost),0) FROM production_labour_settlement_line x JOIN production_labour_accrual a ON a.id=x.accrual_id WHERE x.settlement_id=st.id)
  OR st.actual_cost<>(SELECT coalesce(sum(x.gross_cost+x.employer_cost),0) FROM production_labour_settlement_line x WHERE x.settlement_id=st.id)
  OR st.normal_hours<(SELECT sum(t.hours) FROM production_labour_settlement_line x JOIN production_labour_accrual a ON a.id=x.accrual_id JOIN production_time t ON t.id=a.time_id WHERE x.settlement_id=st.id)
  OR (SELECT coalesce(sum(x.gross_cost),0) FROM production_labour_settlement_line x WHERE x.settlement_id=st.id)<>round(st.eligible_gross::numeric*(SELECT sum(t.hours) FROM production_labour_settlement_line x JOIN production_labour_accrual a ON a.id=x.accrual_id JOIN production_time t ON t.id=a.time_id WHERE x.settlement_id=st.id)/st.normal_hours)
  OR (SELECT coalesce(sum(x.employer_cost),0) FROM production_labour_settlement_line x WHERE x.settlement_id=st.id)<>round(round((s.employer_cpp+s.employer_cpp2+s.employer_ei)::numeric*st.eligible_gross/s.gross)*(SELECT sum(t.hours) FROM production_labour_settlement_line x JOIN production_labour_accrual a ON a.id=x.accrual_id JOIN production_time t ON t.id=a.time_id WHERE x.settlement_id=st.id)/st.normal_hours)
  OR EXISTS(SELECT 1 FROM production_labour_accrual a WHERE a.period_id=st.period_id AND a.created_at<st.created_at AND NOT EXISTS(SELECT 1 FROM production_labour_accrual_reversal v WHERE v.accrual_id=a.id) AND NOT EXISTS(SELECT 1 FROM production_labour_settlement_line x WHERE x.settlement_id=st.id AND x.accrual_id=a.id))))
 THEN RAISE EXCEPTION 'LABOUR_SETTLEMENT_CEILING'; END IF;
 IF EXISTS(SELECT 1 FROM production_labour_settlement v JOIN production_labour_settlement src ON src.id=v.reverse_of JOIN production_event e ON e.id=v.event_id JOIN production_event se ON se.id=src.event_id WHERE v.ledger_id=l AND
  (src.reverse_of IS NOT NULL OR v.period_id<>src.period_id OR v.pay_stub_id<>src.pay_stub_id OR v.estimated_cost<>src.estimated_cost OR v.actual_cost<>src.actual_cost OR v.expense_account_id<>src.expense_account_id OR (e.event_date,e.created_at,e.id)<(se.event_date,se.created_at,se.id)))
 THEN RAISE EXCEPTION 'LABOUR_SETTLEMENT_REVERSAL'; END IF;
 IF EXISTS(SELECT 1 FROM production_labour_cost_adjustment x JOIN production_labour_settlement st ON st.id=x.settlement_id JOIN production_event se ON se.id=st.event_id
  LEFT JOIN production_event e ON e.id=x.event_id LEFT JOIN inventory_cost_layer c ON c.id=x.layer_id LEFT JOIN inventory_item i ON i.id=c.item_id JOIN account ac ON ac.id=x.account_id JOIN ledger lg ON lg.id=x.ledger_id
  WHERE x.ledger_id=l AND (st.ledger_id<>l OR ac.entity_id<>lg.entity_id OR NOT ac.is_postable
   OR x.target_kind='wip' AND (e.ledger_id<>l OR e.order_id<>x.order_id OR e.kind<>'labour_adjustment' OR e.cost<>x.amount OR e.quantity<>0 OR e.item_id IS NOT NULL OR e.event_date<>se.event_date)
   OR x.target_kind='stock' AND (c.ledger_id<>l OR x.basis_quantity<>c.quantity-coalesce((SELECT sum(a.quantity) FROM inventory_cost_allocation a JOIN inventory_movement m ON m.id=a.movement_id WHERE a.layer_id=c.id AND (m.movement_date,m.created_at)<=(se.event_date,x.created_at)),0))
   OR x.target_kind='stock' AND x.cost_after<>c.cost
    +coalesce((SELECT sum(rv.amount) FROM inventory_cost_revaluation rv JOIN inventory_movement m ON m.id=rv.movement_id WHERE rv.layer_id=c.id AND (m.movement_date,m.created_at)<=(se.event_date,x.created_at)),0)
    +coalesce((SELECT sum(rv.amount) FROM production_labour_cost_adjustment rv JOIN production_labour_settlement rs ON rs.id=rv.settlement_id JOIN production_event re ON re.id=rs.event_id WHERE rv.layer_id=c.id AND (re.event_date,rv.created_at,rv.id)<=(se.event_date,x.created_at,x.id)),0)
    -coalesce((SELECT sum(a.cost) FROM inventory_cost_allocation a JOIN inventory_movement m ON m.id=a.movement_id WHERE a.layer_id=c.id AND (m.movement_date,m.created_at)<=(se.event_date,x.created_at)),0)
   OR x.target_kind IN ('wip','stock') AND NOT EXISTS(SELECT 1 FROM operations_account m WHERE m.entity_id=lg.entity_id AND m.seat='/inventory' AND m.account_id=x.account_id AND m.key=CASE WHEN x.target_kind='wip' OR i.kind='work_in_progress' THEN 'wip' ELSE i.kind END)
   OR x.target_kind='expense' AND ac.account_type::text<>'expense'))
 OR EXISTS(SELECT 1 FROM production_event e WHERE e.ledger_id=l AND e.kind='labour_adjustment' AND NOT EXISTS(SELECT 1 FROM production_labour_cost_adjustment x WHERE x.event_id=e.id))
 THEN RAISE EXCEPTION 'LABOUR_CORRECTION_SCOPE'; END IF;
 IF EXISTS(SELECT 1 FROM production_labour_settlement st JOIN operations_journal_event j ON j.source_kind='production' AND j.source_id=st.event_id AND j.ledger_id=st.ledger_id WHERE st.ledger_id=l AND (
   coalesce((SELECT sum(amount) FROM production_labour_cost_adjustment WHERE settlement_id=st.id),0)<>(CASE WHEN st.reverse_of IS NULL THEN 1 ELSE -1 END)*(st.actual_cost-st.estimated_cost)
   OR coalesce((SELECT sum((v->>'amount')::bigint) FROM jsonb_array_elements(j.lines) v WHERE (v->>'accountId')::uuid=st.expense_account_id),0)<>-(CASE WHEN st.reverse_of IS NULL THEN 1 ELSE -1 END)*st.actual_cost
    +coalesce((SELECT sum(amount) FROM production_labour_cost_adjustment WHERE settlement_id=st.id AND account_id=st.expense_account_id),0)))
 THEN RAISE EXCEPTION 'LABOUR_SETTLEMENT_JOURNAL'; END IF;
 IF EXISTS(SELECT 1 FROM inventory_cost_layer c JOIN inventory_cost_layer src ON src.id=c.transfer_source_layer_id JOIN inventory_movement m ON m.id=c.movement_id WHERE c.ledger_id=l AND (src.ledger_id<>l OR src.item_id<>c.item_id OR m.kind<>'transfer' OR src.warehouse_id IS DISTINCT FROM m.from_warehouse_id
  OR c.acquired_on<>src.acquired_on OR c.fifo_order<>src.fifo_order OR NOT EXISTS(SELECT 1 FROM inventory_cost_allocation a WHERE a.movement_id=m.id AND a.layer_id=src.id AND a.quantity=c.quantity AND a.cost=c.cost)))
 THEN RAISE EXCEPTION 'LABOUR_TRANSFER_SOURCE'; END IF;
 IF EXISTS(SELECT 1 FROM inventory_cost_layer c JOIN inventory_movement m ON m.id=c.movement_id WHERE c.ledger_id=l AND m.kind='transfer' AND c.transfer_source_layer_id IS NULL
  AND EXISTS(SELECT 1 FROM production_labour_accrual a JOIN production_event e ON e.id=a.event_id WHERE a.ledger_id=l AND (e.event_date,e.created_at)<=(m.movement_date,m.created_at)))
 THEN RAISE EXCEPTION 'LABOUR_TRANSFER_SOURCE'; END IF;
END $$;

-- Cost provenance uses the original issue, not just net material totals across different issues.
CREATE FUNCTION production_material_source_remaining(p_source uuid,p_before date) RETURNS numeric LANGUAGE plpgsql STABLE AS $$
DECLARE src production_event; ev production_event; planned numeric; done numeric:=0; n numeric:=0; d numeric:=1; g numeric;
BEGIN
 SELECT * INTO STRICT src FROM production_event WHERE id=p_source;
 SELECT planned_quantity INTO planned FROM production_order WHERE id=src.order_id;
 FOR ev IN SELECT * FROM production_event WHERE order_id=src.order_id AND event_date<=p_before ORDER BY event_date,created_at,id LOOP
  IF ev.id=src.id THEN n:=src.quantity; d:=1;
  ELSIF ev.kind='completion' THEN
   n:=n*(planned-done-ev.quantity);d:=d*(planned-done);g:=gcd(n,d);n:=n/g;d:=d/g;
  ELSIF ev.kind='material_return' AND ev.source_event_id=src.id THEN
   n:=n-ev.quantity*d;
   IF n<0 THEN RAISE EXCEPTION 'PRODUCTION_RETURN_SOURCE: Return only the unused portion of the original issue.'; END IF;
  END IF;
  IF ev.kind='completion' THEN done:=done+ev.quantity; END IF;
 END LOOP;
 RETURN div(n,d);
END $$;
