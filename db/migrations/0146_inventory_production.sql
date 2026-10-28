-- Cost-method snapshots preserve historical valuations. Production is register-only.
ALTER TABLE inventory_setting ADD COLUMN cost_method text NOT NULL DEFAULT 'fifo' CHECK(cost_method IN ('fifo','moving_average'));
ALTER TABLE inventory_movement ADD COLUMN cost_method text NOT NULL DEFAULT 'fifo' CHECK(cost_method IN ('fifo','moving_average'));
ALTER TABLE inventory_item DROP CONSTRAINT inventory_item_kind_check;
ALTER TABLE inventory_item ADD CONSTRAINT inventory_item_kind_check CHECK(kind IN ('raw_material','work_in_progress','finished_goods'));
DO $$ DECLARE n text; BEGIN
  SELECT conname INTO STRICT n FROM pg_constraint WHERE conrelid='inventory_cost_layer'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%remaining_cost <= cost%';
  EXECUTE format('ALTER TABLE inventory_cost_layer DROP CONSTRAINT %I',n);
END $$;
ALTER TABLE inventory_cost_layer ADD CONSTRAINT inventory_cost_layer_remaining_cost_check CHECK(remaining_cost>=0);
CREATE TABLE inventory_cost_revaluation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_id uuid NOT NULL REFERENCES ledger(id) ON DELETE CASCADE,
  movement_id uuid NOT NULL, layer_id uuid NOT NULL, amount bigint NOT NULL CHECK(amount<>0),
  FOREIGN KEY(ledger_id,movement_id) REFERENCES inventory_movement(ledger_id,id),
  FOREIGN KEY(ledger_id,layer_id) REFERENCES inventory_cost_layer(ledger_id,id)
);
CREATE TRIGGER inventory_revaluation_immutable BEFORE UPDATE OR DELETE ON inventory_cost_revaluation FOR EACH ROW EXECUTE FUNCTION operations_history_immutable();
CREATE TRIGGER inventory_revaluation_door BEFORE INSERT ON inventory_cost_revaluation FOR EACH ROW EXECUTE FUNCTION inventory_write_guard();

CREATE TABLE production_bom (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),ledger_id uuid NOT NULL REFERENCES ledger(id) ON DELETE CASCADE,
  code text NOT NULL CHECK(length(btrim(code)) BETWEEN 1 AND 60),name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 240),
  output_item_id uuid NOT NULL,output_quantity bigint NOT NULL CHECK(output_quantity>0),
  is_active boolean NOT NULL DEFAULT true,version integer NOT NULL DEFAULT 1 CHECK(version>0),
  notes text NOT NULL DEFAULT '' CHECK(length(notes)<=10000),UNIQUE(ledger_id,id),
  FOREIGN KEY(ledger_id,output_item_id) REFERENCES inventory_item(ledger_id,id)
);
CREATE UNIQUE INDEX production_bom_code ON production_bom(ledger_id,lower(code));
CREATE TABLE production_bom_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),ledger_id uuid NOT NULL REFERENCES ledger(id) ON DELETE CASCADE,
  bom_id uuid NOT NULL,item_id uuid NOT NULL,quantity bigint NOT NULL CHECK(quantity>0),
  FOREIGN KEY(ledger_id,bom_id) REFERENCES production_bom(ledger_id,id),
  FOREIGN KEY(ledger_id,item_id) REFERENCES inventory_item(ledger_id,id),UNIQUE(bom_id,item_id)
);
CREATE TABLE production_order (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),ledger_id uuid NOT NULL REFERENCES ledger(id) ON DELETE CASCADE,
  sequence bigint NOT NULL CHECK(sequence>0),bom_id uuid NOT NULL,bom_version integer NOT NULL,
  output_item_id uuid NOT NULL,warehouse_id uuid NOT NULL,planned_quantity bigint NOT NULL CHECK(planned_quantity>0),
  start_date date NOT NULL,due_date date,notes text NOT NULL DEFAULT '' CHECK(length(notes)<=10000),
  status text NOT NULL DEFAULT 'in_progress' CHECK(status IN ('in_progress','completed','cancelled','closed_loss')),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),request_key uuid NOT NULL,request_hash text NOT NULL,
  created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(ledger_id,id),UNIQUE(ledger_id,sequence),UNIQUE(ledger_id,request_key),
  FOREIGN KEY(ledger_id,bom_id) REFERENCES production_bom(ledger_id,id),
  FOREIGN KEY(ledger_id,output_item_id) REFERENCES inventory_item(ledger_id,id),
  FOREIGN KEY(ledger_id,warehouse_id) REFERENCES inventory_warehouse(ledger_id,id),CHECK(due_date IS NULL OR due_date>=start_date)
);
CREATE TABLE production_order_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),ledger_id uuid NOT NULL REFERENCES ledger(id) ON DELETE CASCADE,
  order_id uuid NOT NULL,item_id uuid NOT NULL,quantity bigint NOT NULL CHECK(quantity>0),
  FOREIGN KEY(ledger_id,order_id) REFERENCES production_order(ledger_id,id),
  FOREIGN KEY(ledger_id,item_id) REFERENCES inventory_item(ledger_id,id),UNIQUE(order_id,item_id)
);
CREATE TABLE production_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),ledger_id uuid NOT NULL REFERENCES ledger(id) ON DELETE CASCADE,
  order_id uuid NOT NULL,event_date date NOT NULL,
  kind text NOT NULL CHECK(kind IN ('material_issue','material_return','conversion_cost','completion','loss','cancel')),
  item_id uuid,movement_id uuid,source_event_id uuid,
  quantity bigint NOT NULL DEFAULT 0 CHECK(quantity>=0),cost bigint NOT NULL DEFAULT 0 CHECK(cost>=0),
  note text NOT NULL DEFAULT '' CHECK(length(note)<=10000),request_key uuid NOT NULL,request_hash text NOT NULL,
  created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(ledger_id,id),UNIQUE(ledger_id,request_key),
  FOREIGN KEY(ledger_id,order_id) REFERENCES production_order(ledger_id,id),
  FOREIGN KEY(ledger_id,item_id) REFERENCES inventory_item(ledger_id,id),
  FOREIGN KEY(ledger_id,movement_id) REFERENCES inventory_movement(ledger_id,id),
  FOREIGN KEY(ledger_id,source_event_id) REFERENCES production_event(ledger_id,id),
  CHECK((kind IN ('material_issue','material_return','completion'))=(movement_id IS NOT NULL)),
  CHECK((kind='material_return')=(source_event_id IS NOT NULL)),
  CHECK(kind NOT IN ('material_issue','material_return','completion') OR quantity>0),
  CHECK(kind NOT IN ('conversion_cost','loss','cancel') OR length(btrim(note))>0)
);
CREATE INDEX production_event_order ON production_event(ledger_id,order_id,event_date,created_at);
CREATE TRIGGER production_order_line_immutable BEFORE UPDATE OR DELETE ON production_order_line FOR EACH ROW EXECUTE FUNCTION operations_history_immutable();
CREATE TRIGGER production_event_immutable BEFORE UPDATE OR DELETE ON production_event FOR EACH ROW EXECUTE FUNCTION operations_history_immutable();
CREATE TRIGGER production_bom_audit AFTER INSERT OR UPDATE OR DELETE ON production_bom FOR EACH ROW EXECUTE FUNCTION operations_audit();
CREATE TRIGGER production_bom_line_audit AFTER INSERT OR UPDATE OR DELETE ON production_bom_line FOR EACH ROW EXECUTE FUNCTION operations_audit();
CREATE TRIGGER production_order_audit AFTER INSERT OR UPDATE OR DELETE ON production_order FOR EACH ROW EXECUTE FUNCTION operations_audit();
CREATE TRIGGER production_event_audit AFTER INSERT ON production_event FOR EACH ROW EXECUTE FUNCTION operations_audit();

CREATE FUNCTION inventory_kind_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE production_used boolean;
BEGIN
  production_used:=EXISTS(SELECT 1 FROM production_order o LEFT JOIN production_order_line p ON p.order_id=o.id WHERE o.output_item_id=OLD.id OR p.item_id=OLD.id);
  IF NEW.kind<>OLD.kind AND (production_used OR EXISTS(SELECT 1 FROM inventory_movement WHERE item_id=OLD.id)) THEN RAISE EXCEPTION 'INVENTORY_TYPE_IMMUTABLE'; END IF;
  IF production_used AND (NEW.unit,NEW.track_batches,NEW.track_serials) IS DISTINCT FROM (OLD.unit,OLD.track_batches,OLD.track_serials) THEN RAISE EXCEPTION 'INVENTORY_TRACKING_IMMUTABLE'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inventory_item_kind BEFORE UPDATE ON inventory_item FOR EACH ROW EXECUTE FUNCTION inventory_kind_guard();

CREATE FUNCTION inventory_revaluation_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM inventory_cost_revaluation r JOIN inventory_cost_layer l ON l.id=r.layer_id
    WHERE r.movement_id=NEW.id AND (NEW.cost_method<>'moving_average' OR l.item_id<>NEW.item_id
      OR l.warehouse_id IS DISTINCT FROM NEW.from_warehouse_id AND l.warehouse_id IS DISTINCT FROM NEW.to_warehouse_id))
    OR EXISTS(SELECT 1 FROM inventory_cost_revaluation r JOIN inventory_cost_layer l ON l.id=r.layer_id
      WHERE r.movement_id=NEW.id GROUP BY l.warehouse_id HAVING sum(r.amount)<>0) THEN RAISE EXCEPTION 'AVERAGE_COST_REVALUATION_INVALID'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER inventory_revaluation_complete AFTER INSERT ON inventory_movement DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inventory_revaluation_check();

CREATE OR REPLACE FUNCTION operations_validate_ledger(l uuid) RETURNS void LANGUAGE plpgsql STABLE AS $$
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
       OR c.remaining_cost<>c.cost+(SELECT coalesce(sum(amount),0) FROM inventory_cost_revaluation WHERE layer_id=c.id)-(SELECT coalesce(sum(cost),0) FROM inventory_cost_allocation WHERE layer_id=c.id)))
    OR EXISTS(SELECT 1 FROM inventory_cost_revaluation r JOIN inventory_cost_layer c ON c.id=r.layer_id WHERE r.ledger_id=l GROUP BY r.movement_id,c.warehouse_id HAVING sum(r.amount)<>0)
    OR EXISTS(SELECT 1 FROM inventory_stock s JOIN inventory_item i ON i.id=s.item_id WHERE s.ledger_id=l AND (i.track_batches<>(s.batch<>'') OR i.track_serials<>(s.serial<>''))) THEN
      RAISE EXCEPTION 'INVENTORY_REGISTER_INCONSISTENT: Stock and costs must reconcile to movement history.';
  END IF;
  IF EXISTS(SELECT 1 FROM fixed_asset_activity x JOIN fixed_asset a ON a.id=x.asset_id WHERE x.ledger_id=l AND (x.activity_date<a.acquired_on OR x.activity_date>a.disposed_on)) THEN RAISE EXCEPTION 'ASSET_ACTIVITY_DATES_INCONSISTENT'; END IF;
  IF EXISTS(SELECT 1 FROM production_order o WHERE o.ledger_id=l AND (
    (SELECT coalesce(sum(CASE WHEN kind IN ('material_issue','conversion_cost') THEN cost ELSE -cost END),0) FROM production_event WHERE order_id=o.id)<0
    OR (SELECT coalesce(sum(quantity),0) FROM production_event WHERE order_id=o.id AND kind='completion')>o.planned_quantity
    OR o.status<>'in_progress' AND (SELECT coalesce(sum(CASE WHEN kind IN ('material_issue','conversion_cost') THEN cost ELSE -cost END),0) FROM production_event WHERE order_id=o.id)<>0)) THEN RAISE EXCEPTION 'PRODUCTION_REGISTER_INCONSISTENT'; END IF;
  IF EXISTS(SELECT 1 FROM inventory_cost_revaluation r JOIN inventory_cost_layer c ON c.id=r.layer_id JOIN inventory_movement m ON m.id=r.movement_id WHERE r.ledger_id=l AND (m.cost_method<>'moving_average' OR c.item_id<>m.item_id OR c.warehouse_id IS DISTINCT FROM m.from_warehouse_id AND c.warehouse_id IS DISTINCT FROM m.to_warehouse_id)) THEN RAISE EXCEPTION 'AVERAGE_COST_REVALUATION_INVALID'; END IF;
  IF EXISTS(SELECT 1 FROM production_order o WHERE o.ledger_id=l AND NOT EXISTS(SELECT 1 FROM production_order_line WHERE order_id=o.id))
    OR EXISTS(SELECT 1 FROM production_order_line x JOIN production_order o ON o.id=x.order_id WHERE x.ledger_id=l AND x.item_id=o.output_item_id)
    OR EXISTS(SELECT 1 FROM production_event e JOIN production_order o ON o.id=e.order_id WHERE e.ledger_id=l AND e.event_date<o.start_date)
    OR EXISTS(SELECT 1 FROM production_event e JOIN production_event src ON src.id=e.source_event_id WHERE e.ledger_id=l AND (src.kind<>'material_issue' OR src.order_id<>e.order_id OR src.item_id<>e.item_id))
    OR EXISTS(SELECT 1 FROM production_event src WHERE src.ledger_id=l AND src.kind='material_issue' AND (SELECT coalesce(sum(quantity),0) FROM production_event WHERE source_event_id=src.id)>src.quantity)
    OR EXISTS(SELECT 1 FROM (SELECT sum(CASE WHEN kind IN ('material_issue','conversion_cost') THEN cost ELSE -cost END) OVER(PARTITION BY order_id ORDER BY event_date,created_at,id) AS running FROM production_event WHERE ledger_id=l) x WHERE running<0)
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

CREATE FUNCTION production_order_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.inventory_write',true) IS DISTINCT FROM 'on' THEN RAISE EXCEPTION 'PRODUCTION_WRITE_DOOR'; END IF;
  IF TG_OP='UPDATE' AND ((to_jsonb(NEW)-ARRAY['status','version']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','version']) OR OLD.status<>'in_progress') THEN RAISE EXCEPTION 'PRODUCTION_ORDER_IMMUTABLE'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER production_order_door BEFORE INSERT OR UPDATE ON production_order FOR EACH ROW EXECUTE FUNCTION production_order_guard();
CREATE TRIGGER production_event_door BEFORE INSERT ON production_event FOR EACH ROW EXECUTE FUNCTION inventory_write_guard();
CREATE TRIGGER production_order_line_door BEFORE INSERT ON production_order_line FOR EACH ROW EXECUTE FUNCTION inventory_write_guard();
CREATE FUNCTION production_register_check() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM operations_validate_ledger(NEW.ledger_id); RETURN NULL; END $$;
CREATE CONSTRAINT TRIGGER production_event_balance AFTER INSERT ON production_event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION production_register_check();
CREATE CONSTRAINT TRIGGER production_order_balance AFTER INSERT OR UPDATE ON production_order DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION production_register_check();
