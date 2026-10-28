-- Restore the asset/book/CCA/deferred-tax validator chain after 0150.
-- The labour-aware inventory body belongs at the inventory layer; upper asset
-- wrappers must continue to validate immutable histories and restore payloads.
-- Published 0149/0150 checksums remain unchanged.

CREATE OR REPLACE FUNCTION operations_validate_inventory(l uuid) RETURNS void LANGUAGE plpgsql STABLE AS $$
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

CREATE OR REPLACE FUNCTION operations_validate_register(l uuid) RETURNS void LANGUAGE plpgsql STABLE AS $$
DECLARE review_row record; debit numeric;credit numeric;dl numeric;da numeric;counter numeric;counterpart text;
BEGIN
  PERFORM operations_validate_book_tax_base(l);
  IF EXISTS(SELECT 1 FROM asset_depreciation_policy_revision r JOIN fixed_asset a ON a.id=r.asset_id WHERE r.ledger_id=l AND
      (r.effective_on<>(r.after_policy->>'start_date')::date OR extract(day FROM r.effective_on)<>1
      OR (r.before_policy->>'start_date')::date>=r.effective_on
      OR (r.after_policy->>'version')::integer<>(r.before_policy->>'version')::integer+1
      OR (r.after_policy->>'opening_accumulated')::bigint<>(SELECT coalesce(sum(amount),0) FROM asset_depreciation_entry WHERE asset_id=r.asset_id AND entry_date<r.effective_on)
      OR (r.after_policy->>'residual_value')::bigint>a.acquisition_cost-(r.after_policy->>'opening_accumulated')::bigint))
    OR EXISTS(SELECT 1 FROM asset_depreciation_policy p JOIN LATERAL (SELECT after_policy FROM asset_depreciation_policy_revision WHERE asset_id=p.asset_id ORDER BY effective_on DESC LIMIT 1) r ON true WHERE p.ledger_id=l AND
      (p.start_date<>(r.after_policy->>'start_date')::date OR p.version<>(r.after_policy->>'version')::integer
      OR p.method<>r.after_policy->>'method' OR p.residual_value<>(r.after_policy->>'residual_value')::bigint
      OR p.life_months<>(r.after_policy->>'life_months')::integer OR p.annual_rate_bp<>(r.after_policy->>'annual_rate_bp')::integer
      OR p.opening_accumulated<>(r.after_policy->>'opening_accumulated')::bigint)) THEN RAISE EXCEPTION 'BOOK_ESTIMATE_HISTORY_INCONSISTENT'; END IF;
  IF EXISTS(SELECT 1 FROM (SELECT before_policy,lag(after_policy) OVER(PARTITION BY asset_id ORDER BY effective_on) prior FROM asset_depreciation_policy_revision WHERE ledger_id=l) r
    WHERE prior IS NOT NULL AND (before_policy-'id'-'asset_id')<>prior) THEN RAISE EXCEPTION 'BOOK_ESTIMATE_CONTINUITY_INCONSISTENT'; END IF;
  IF EXISTS(SELECT 1 FROM (SELECT x.*,lag(id) OVER(PARTITION BY pool_id ORDER BY reporting_date,revision) previous_id,
      lag(liability) OVER(PARTITION BY pool_id ORDER BY reporting_date,revision) prior_l,
      lag(recognized_asset) OVER(PARTITION BY pool_id ORDER BY reporting_date,revision) prior_a,
      row_number() OVER(PARTITION BY pool_id,cca_year_id ORDER BY revision) expected_revision
    FROM asset_deferred_tax_review x WHERE ledger_id=l) x JOIN asset_cca_year y ON y.id=x.cca_year_id JOIN ledger g ON g.id=x.ledger_id
    WHERE g.currency<>'CAD' OR x.pool_id<>y.pool_id OR x.reporting_date<>y.end_date OR x.closing_ucc<>y.closing_ucc OR x.revision<>x.expected_revision
      OR x.book_value<>(SELECT coalesce(sum(a.acquisition_cost-coalesce((SELECT sum(amount) FROM asset_depreciation_entry WHERE asset_id=a.id AND entry_date<=x.reporting_date),0)),0)
        FROM asset_cca_assignment ca JOIN fixed_asset a ON a.id=ca.asset_id WHERE ca.pool_id=x.pool_id AND a.acquired_on<=x.reporting_date AND (a.disposed_on IS NULL OR a.disposed_on>x.reporting_date))
      OR x.pending_tax_cost<>(SELECT coalesce(sum(ca.tax_cost),0) FROM asset_cca_assignment ca JOIN fixed_asset a ON a.id=ca.asset_id WHERE ca.pool_id=x.pool_id AND a.acquired_on<=x.reporting_date AND ca.available_on>x.reporting_date AND (ca.disposed_on IS NULL OR ca.disposed_on>x.reporting_date))
      OR x.previous_review_id IS DISTINCT FROM x.previous_id
      OR (x.previous_id IS NOT NULL AND (x.previous_liability<>x.prior_l OR x.previous_asset<>x.prior_a)))
    THEN RAISE EXCEPTION 'DEFERRED_TAX_HISTORY_INCONSISTENT'; END IF;
  FOR review_row IN SELECT * FROM asset_deferred_tax_review WHERE ledger_id=l LOOP
    counterpart:=CASE review_row.recognition WHEN 'profit_loss' THEN 'Income tax expense — deferred' WHEN 'oci' THEN 'Other comprehensive income — tax' ELSE 'Equity — tax adjustment' END;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(review_row.journal) j WHERE j->>'account' IS NULL OR j->>'account' NOT IN ('Deferred tax liability','Deferred tax asset',counterpart)
      OR coalesce(j->>'debit','') !~ '^[0-9]+$' OR coalesce(j->>'credit','') !~ '^[0-9]+$') THEN RAISE EXCEPTION 'DEFERRED_TAX_JOURNAL_INCONSISTENT'; END IF;
    SELECT coalesce(sum((j->>'debit')::numeric),0),coalesce(sum((j->>'credit')::numeric),0),
      coalesce(sum((j->>'credit')::numeric-(j->>'debit')::numeric) FILTER(WHERE j->>'account'='Deferred tax liability'),0),
      coalesce(sum((j->>'debit')::numeric-(j->>'credit')::numeric) FILTER(WHERE j->>'account'='Deferred tax asset'),0),
      coalesce(sum((j->>'debit')::numeric-(j->>'credit')::numeric) FILTER(WHERE j->>'account'=counterpart),0)
      INTO debit,credit,dl,da,counter FROM jsonb_array_elements(review_row.journal) j;
    IF debit<>credit OR dl<>review_row.liability-review_row.previous_liability OR da<>review_row.recognized_asset-review_row.previous_asset OR counter<>dl-da THEN RAISE EXCEPTION 'DEFERRED_TAX_JOURNAL_INCONSISTENT'; END IF;
  END LOOP;
END $$;
