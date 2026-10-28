-- Operational registers only: these tables never create journal entries.
-- Quantities are millionths of a unit; monetary values are integer cents.
CREATE TABLE fixed_asset (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_id uuid NOT NULL REFERENCES ledger(id) ON DELETE CASCADE,
  code text NOT NULL CHECK(length(btrim(code)) BETWEEN 1 AND 60),
  name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 240),
  category text NOT NULL DEFAULT '' CHECK(length(category)<=120),
  acquired_on date NOT NULL, in_service_on date, warranty_until date,
  acquisition_cost bigint NOT NULL CHECK(acquisition_cost>=0),
  supplier text NOT NULL DEFAULT '' CHECK(length(supplier)<=240),
  serial_number text NOT NULL DEFAULT '' CHECK(length(serial_number)<=120),
  location text NOT NULL DEFAULT '' CHECK(length(location)<=240),
  custodian text NOT NULL DEFAULT '' CHECK(length(custodian)<=240),
  status text NOT NULL DEFAULT 'in_use' CHECK(status IN ('in_use','in_storage','under_repair','disposed')),
  disposed_on date, disposal_proceeds bigint NOT NULL DEFAULT 0 CHECK(disposal_proceeds>=0),
  notes text NOT NULL DEFAULT '' CHECK(length(notes)<=10000),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(ledger_id,id),
  CHECK(in_service_on IS NULL OR in_service_on>=acquired_on),
  CHECK(warranty_until IS NULL OR warranty_until>=acquired_on),
  CHECK((status='disposed')=(disposed_on IS NOT NULL)),
  CHECK(disposed_on IS NULL OR disposed_on>=coalesce(in_service_on,acquired_on)),
  CHECK(status='disposed' OR disposal_proceeds=0)
);
CREATE UNIQUE INDEX fixed_asset_code ON fixed_asset(ledger_id,lower(code));
CREATE TABLE fixed_asset_activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_id uuid NOT NULL REFERENCES ledger(id) ON DELETE CASCADE,
  asset_id uuid NOT NULL,
  activity_date date NOT NULL,
  kind text NOT NULL CHECK(kind IN ('maintenance','inspection','note')),
  note text NOT NULL CHECK(length(btrim(note)) BETWEEN 1 AND 10000),
  cost bigint NOT NULL DEFAULT 0 CHECK(cost>=0),
  request_key uuid NOT NULL, request_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), created_by text NOT NULL,
  FOREIGN KEY(ledger_id,asset_id) REFERENCES fixed_asset(ledger_id,id),
  UNIQUE(ledger_id,request_key)
);
CREATE INDEX fixed_asset_activity_asset ON fixed_asset_activity(asset_id,activity_date);

CREATE TABLE inventory_setting (
  ledger_id uuid PRIMARY KEY REFERENCES ledger(id) ON DELETE CASCADE,
  warehouses_enabled boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK(version>0)
);
CREATE TABLE inventory_item (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_id uuid NOT NULL REFERENCES ledger(id) ON DELETE CASCADE,
  sku text NOT NULL CHECK(length(btrim(sku)) BETWEEN 1 AND 60),
  name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 240),
  kind text NOT NULL CHECK(kind IN ('finished_goods','raw_material')),
  unit text NOT NULL DEFAULT 'each' CHECK(length(btrim(unit)) BETWEEN 1 AND 30),
  reorder_level bigint NOT NULL DEFAULT 0 CHECK(reorder_level>=0),
  track_batches boolean NOT NULL DEFAULT false,
  track_serials boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  notes text NOT NULL DEFAULT '' CHECK(length(notes)<=10000),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(ledger_id,id)
);
CREATE UNIQUE INDEX inventory_item_sku ON inventory_item(ledger_id,lower(sku));
CREATE TABLE inventory_warehouse (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_id uuid NOT NULL REFERENCES ledger(id) ON DELETE CASCADE,
  code text NOT NULL CHECK(length(btrim(code)) BETWEEN 1 AND 60),
  name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 240),
  is_default boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  UNIQUE(ledger_id,id), CHECK(NOT is_default OR is_active)
);
CREATE UNIQUE INDEX inventory_warehouse_code ON inventory_warehouse(ledger_id,lower(code));
CREATE UNIQUE INDEX inventory_default_warehouse ON inventory_warehouse(ledger_id) WHERE is_default;
CREATE TABLE inventory_movement (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_id uuid NOT NULL REFERENCES ledger(id) ON DELETE CASCADE,
  item_id uuid NOT NULL,
  sequence bigint NOT NULL CHECK(sequence>0),
  movement_date date NOT NULL,
  kind text NOT NULL CHECK(kind IN ('receipt','issue','transfer','adjust_in','adjust_out')),
  from_warehouse_id uuid, to_warehouse_id uuid,
  quantity bigint NOT NULL CHECK(quantity>0),
  cost bigint NOT NULL CHECK(cost>=0),
  reference text NOT NULL DEFAULT '' CHECK(length(reference)<=240),
  note text NOT NULL DEFAULT '' CHECK(length(note)<=10000),
  request_key uuid NOT NULL, request_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), created_by text NOT NULL,
  UNIQUE(ledger_id,id), UNIQUE(ledger_id,sequence), UNIQUE(ledger_id,request_key),
  FOREIGN KEY(ledger_id,item_id) REFERENCES inventory_item(ledger_id,id),
  FOREIGN KEY(ledger_id,from_warehouse_id) REFERENCES inventory_warehouse(ledger_id,id),
  FOREIGN KEY(ledger_id,to_warehouse_id) REFERENCES inventory_warehouse(ledger_id,id),
  CHECK(CASE WHEN kind IN ('receipt','adjust_in') THEN from_warehouse_id IS NULL AND to_warehouse_id IS NOT NULL
    WHEN kind IN ('issue','adjust_out') THEN from_warehouse_id IS NOT NULL AND to_warehouse_id IS NULL
    ELSE from_warehouse_id IS NOT NULL AND to_warehouse_id IS NOT NULL AND from_warehouse_id<>to_warehouse_id END),
  CHECK(kind NOT IN ('adjust_in','adjust_out') OR length(btrim(note))>0)
);
CREATE INDEX inventory_movement_history ON inventory_movement(ledger_id,item_id,movement_date,sequence);
CREATE TABLE inventory_stock (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_id uuid NOT NULL REFERENCES ledger(id) ON DELETE CASCADE,
  item_id uuid NOT NULL, warehouse_id uuid NOT NULL,
  batch text NOT NULL DEFAULT '' CHECK(length(batch)<=120),
  serial text NOT NULL DEFAULT '' CHECK(length(serial)<=120),
  quantity bigint NOT NULL DEFAULT 0 CHECK(quantity>=0),
  UNIQUE(ledger_id,id), UNIQUE(ledger_id,item_id,warehouse_id,batch,serial),
  FOREIGN KEY(ledger_id,item_id) REFERENCES inventory_item(ledger_id,id),
  FOREIGN KEY(ledger_id,warehouse_id) REFERENCES inventory_warehouse(ledger_id,id),
  CHECK(serial='' OR quantity IN (0,1000000))
);
CREATE UNIQUE INDEX inventory_live_serial ON inventory_stock(ledger_id,item_id,serial) WHERE serial<>'' AND quantity>0;
CREATE TABLE inventory_stock_change (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_id uuid NOT NULL REFERENCES ledger(id) ON DELETE CASCADE,
  movement_id uuid NOT NULL, stock_id uuid NOT NULL,
  quantity bigint NOT NULL CHECK(quantity<>0),
  FOREIGN KEY(ledger_id,movement_id) REFERENCES inventory_movement(ledger_id,id),
  FOREIGN KEY(ledger_id,stock_id) REFERENCES inventory_stock(ledger_id,id)
);
CREATE TABLE inventory_cost_layer (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_id uuid NOT NULL REFERENCES ledger(id) ON DELETE CASCADE,
  item_id uuid NOT NULL, warehouse_id uuid NOT NULL, movement_id uuid NOT NULL,
  acquired_on date NOT NULL, fifo_order bigint NOT NULL CHECK(fifo_order>0),
  quantity bigint NOT NULL CHECK(quantity>0), cost bigint NOT NULL CHECK(cost>=0),
  remaining_quantity bigint NOT NULL CHECK(remaining_quantity BETWEEN 0 AND quantity),
  remaining_cost bigint NOT NULL CHECK(remaining_cost BETWEEN 0 AND cost),
  UNIQUE(ledger_id,id),
  FOREIGN KEY(ledger_id,item_id) REFERENCES inventory_item(ledger_id,id),
  FOREIGN KEY(ledger_id,warehouse_id) REFERENCES inventory_warehouse(ledger_id,id),
  FOREIGN KEY(ledger_id,movement_id) REFERENCES inventory_movement(ledger_id,id),
  CHECK(remaining_quantity<>0 OR remaining_cost=0)
);
CREATE INDEX inventory_fifo ON inventory_cost_layer(ledger_id,item_id,warehouse_id,acquired_on,fifo_order) WHERE remaining_quantity>0;
CREATE TABLE inventory_cost_allocation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_id uuid NOT NULL REFERENCES ledger(id) ON DELETE CASCADE,
  movement_id uuid NOT NULL, layer_id uuid NOT NULL,
  quantity bigint NOT NULL CHECK(quantity>0), cost bigint NOT NULL CHECK(cost>=0),
  FOREIGN KEY(ledger_id,movement_id) REFERENCES inventory_movement(ledger_id,id),
  FOREIGN KEY(ledger_id,layer_id) REFERENCES inventory_cost_layer(ledger_id,id)
);

-- History is append-only; removal of an entire company is still supported.
CREATE FUNCTION operations_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND NOT EXISTS(SELECT 1 FROM ledger WHERE id=OLD.ledger_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'OPERATIONS_HISTORY_IMMUTABLE: Record a correcting movement or activity instead.';
END $$;
CREATE TRIGGER asset_activity_immutable BEFORE UPDATE OR DELETE ON fixed_asset_activity FOR EACH ROW EXECUTE FUNCTION operations_history_immutable();
CREATE TRIGGER stock_movement_immutable BEFORE UPDATE OR DELETE ON inventory_movement FOR EACH ROW EXECUTE FUNCTION operations_history_immutable();
CREATE TRIGGER stock_change_immutable BEFORE UPDATE OR DELETE ON inventory_stock_change FOR EACH ROW EXECUTE FUNCTION operations_history_immutable();
CREATE TRIGGER stock_allocation_immutable BEFORE UPDATE OR DELETE ON inventory_cost_allocation FOR EACH ROW EXECUTE FUNCTION operations_history_immutable();

CREATE FUNCTION inventory_write_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND NOT EXISTS(SELECT 1 FROM ledger WHERE id=OLD.ledger_id) THEN RETURN OLD; END IF;
  IF current_setting('app.inventory_write',true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'INVENTORY_WRITE_DOOR: Use the inventory movement workflow.';
  END IF;
  IF TG_OP='UPDATE' AND TG_TABLE_NAME='inventory_cost_layer'
    AND (to_jsonb(NEW)-ARRAY['remaining_quantity','remaining_cost']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['remaining_quantity','remaining_cost']) THEN
    RAISE EXCEPTION 'FIFO_LAYER_IMMUTABLE';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inventory_stock_door BEFORE INSERT OR UPDATE OR DELETE ON inventory_stock FOR EACH ROW EXECUTE FUNCTION inventory_write_guard();
CREATE TRIGGER inventory_layer_door BEFORE INSERT OR UPDATE OR DELETE ON inventory_cost_layer FOR EACH ROW EXECUTE FUNCTION inventory_write_guard();
CREATE TRIGGER inventory_movement_door BEFORE INSERT ON inventory_movement FOR EACH ROW EXECUTE FUNCTION inventory_write_guard();
CREATE TRIGGER inventory_change_door BEFORE INSERT ON inventory_stock_change FOR EACH ROW EXECUTE FUNCTION inventory_write_guard();
CREATE TRIGGER inventory_allocation_door BEFORE INSERT ON inventory_cost_allocation FOR EACH ROW EXECUTE FUNCTION inventory_write_guard();

-- Commit-time check catches an interrupted or incomplete physical/cost update.
CREATE FUNCTION inventory_balance_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i uuid; l uuid;
BEGIN
  i:=coalesce(NEW.item_id,OLD.item_id); l:=coalesce(NEW.ledger_id,OLD.ledger_id);
  IF EXISTS(SELECT 1 FROM (
    SELECT warehouse_id,sum(q) q FROM (
      SELECT warehouse_id,quantity q FROM inventory_stock WHERE ledger_id=l AND item_id=i
      UNION ALL SELECT warehouse_id,-remaining_quantity FROM inventory_cost_layer WHERE ledger_id=l AND item_id=i
    ) s GROUP BY warehouse_id HAVING sum(q)<>0
  ) x) THEN RAISE EXCEPTION 'INVENTORY_COST_QUANTITY_MISMATCH'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER inventory_stock_balance AFTER INSERT OR UPDATE OR DELETE ON inventory_stock DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inventory_balance_check();
CREATE CONSTRAINT TRIGGER inventory_layer_balance AFTER INSERT OR UPDATE OR DELETE ON inventory_cost_layer DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inventory_balance_check();

CREATE FUNCTION inventory_movement_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q bigint; c bigint;
BEGIN
  IF EXISTS(SELECT 1 FROM inventory_stock_change x JOIN inventory_stock s ON s.id=x.stock_id
      WHERE x.movement_id=NEW.id AND (s.item_id<>NEW.item_id OR s.warehouse_id IS DISTINCT FROM NEW.from_warehouse_id AND s.warehouse_id IS DISTINCT FROM NEW.to_warehouse_id
        OR x.quantity<0 AND s.warehouse_id IS DISTINCT FROM NEW.from_warehouse_id OR x.quantity>0 AND s.warehouse_id IS DISTINCT FROM NEW.to_warehouse_id)) THEN RAISE EXCEPTION 'INVENTORY_MOVEMENT_STOCK_SCOPE'; END IF;
  SELECT coalesce(sum(x.quantity) FILTER(WHERE x.quantity<0),0),coalesce(sum(x.quantity) FILTER(WHERE x.quantity>0),0) INTO q,c FROM inventory_stock_change x WHERE x.movement_id=NEW.id;
  IF q<>(CASE WHEN NEW.from_warehouse_id IS NULL THEN 0 ELSE -NEW.quantity END) OR c<>(CASE WHEN NEW.to_warehouse_id IS NULL THEN 0 ELSE NEW.quantity END) THEN RAISE EXCEPTION 'INVENTORY_MOVEMENT_STOCK_TOTAL'; END IF;
  SELECT coalesce(sum(quantity),0),coalesce(sum(cost),0) INTO q,c FROM inventory_cost_allocation WHERE movement_id=NEW.id;
  IF NEW.from_warehouse_id IS NULL AND (q<>0 OR c<>0) OR NEW.from_warehouse_id IS NOT NULL AND (q<>NEW.quantity OR c<>NEW.cost) THEN RAISE EXCEPTION 'INVENTORY_MOVEMENT_FIFO_TOTAL'; END IF;
  IF EXISTS(SELECT 1 FROM inventory_cost_allocation a JOIN inventory_cost_layer l ON l.id=a.layer_id WHERE a.movement_id=NEW.id AND (l.item_id<>NEW.item_id OR l.warehouse_id IS DISTINCT FROM NEW.from_warehouse_id)) THEN RAISE EXCEPTION 'INVENTORY_MOVEMENT_FIFO_SCOPE'; END IF;
  SELECT coalesce(sum(quantity),0),coalesce(sum(cost),0) INTO q,c FROM inventory_cost_layer WHERE movement_id=NEW.id;
  IF NEW.to_warehouse_id IS NULL AND (q<>0 OR c<>0) OR NEW.to_warehouse_id IS NOT NULL AND (q<>NEW.quantity OR c<>NEW.cost) THEN RAISE EXCEPTION 'INVENTORY_MOVEMENT_LAYER_TOTAL'; END IF;
  IF EXISTS(SELECT 1 FROM inventory_cost_layer WHERE movement_id=NEW.id AND (item_id<>NEW.item_id OR warehouse_id IS DISTINCT FROM NEW.to_warehouse_id)) THEN RAISE EXCEPTION 'INVENTORY_MOVEMENT_LAYER_SCOPE'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER inventory_complete_movement AFTER INSERT ON inventory_movement DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inventory_movement_check();

CREATE FUNCTION inventory_metadata_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item inventory_item;
BEGIN
  IF TG_TABLE_NAME='inventory_stock' THEN
    SELECT * INTO STRICT item FROM inventory_item WHERE ledger_id=NEW.ledger_id AND id=NEW.item_id;
    IF item.track_batches<>(NEW.batch<>'') OR item.track_serials<>(NEW.serial<>'') THEN RAISE EXCEPTION 'INVENTORY_TRACKING_MISMATCH'; END IF;
    IF TG_OP='UPDATE' AND (to_jsonb(NEW)-'quantity') IS DISTINCT FROM (to_jsonb(OLD)-'quantity') THEN RAISE EXCEPTION 'INVENTORY_STOCK_IDENTITY_IMMUTABLE'; END IF;
  ELSIF TG_TABLE_NAME='inventory_item' THEN
    IF (NEW.ledger_id,NEW.id) IS DISTINCT FROM (OLD.ledger_id,OLD.id) THEN RAISE EXCEPTION 'INVENTORY_ITEM_SCOPE_IMMUTABLE'; END IF;
    IF (NEW.unit,NEW.track_batches,NEW.track_serials) IS DISTINCT FROM (OLD.unit,OLD.track_batches,OLD.track_serials)
        AND EXISTS(SELECT 1 FROM inventory_movement WHERE item_id=OLD.id) THEN RAISE EXCEPTION 'INVENTORY_TRACKING_IMMUTABLE'; END IF;
    IF NOT NEW.is_active AND EXISTS(SELECT 1 FROM inventory_stock WHERE item_id=OLD.id AND quantity>0) THEN RAISE EXCEPTION 'INVENTORY_ITEM_HAS_STOCK'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inventory_stock_metadata BEFORE INSERT OR UPDATE ON inventory_stock FOR EACH ROW EXECUTE FUNCTION inventory_metadata_guard();
CREATE TRIGGER inventory_item_metadata BEFORE UPDATE ON inventory_item FOR EACH ROW EXECUTE FUNCTION inventory_metadata_guard();

CREATE FUNCTION operations_audit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a jsonb; b jsonb; l uuid; e uuid;
BEGIN
  IF TG_OP<>'INSERT' THEN b:=to_jsonb(OLD); END IF;
  IF TG_OP<>'DELETE' THEN a:=to_jsonb(NEW); END IF;
  l:=coalesce(a->>'ledger_id',b->>'ledger_id')::uuid;
  SELECT entity_id INTO e FROM ledger WHERE id=l;
  IF e IS NOT NULL THEN
    INSERT INTO audit_log(actor,action,table_name,record_id,before,after,entity_id,ledger_id,scope,target_label)
    VALUES(coalesce(nullif(current_setting('app.actor',true),''),current_user),lower(TG_OP)||'_'||TG_TABLE_NAME,
      TG_TABLE_NAME,coalesce(a->>'id',b->>'id',l::text),b,a,e,l,'company',coalesce(a->>'name',b->>'name',a->>'reference',b->>'reference'));
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER fixed_asset_audit AFTER INSERT OR UPDATE OR DELETE ON fixed_asset FOR EACH ROW EXECUTE FUNCTION operations_audit();
CREATE TRIGGER fixed_asset_activity_audit AFTER INSERT ON fixed_asset_activity FOR EACH ROW EXECUTE FUNCTION operations_audit();
CREATE TRIGGER inventory_setting_audit AFTER INSERT OR UPDATE OR DELETE ON inventory_setting FOR EACH ROW EXECUTE FUNCTION operations_audit();
CREATE TRIGGER inventory_item_audit AFTER INSERT OR UPDATE OR DELETE ON inventory_item FOR EACH ROW EXECUTE FUNCTION operations_audit();
CREATE TRIGGER inventory_warehouse_audit AFTER INSERT OR UPDATE OR DELETE ON inventory_warehouse FOR EACH ROW EXECUTE FUNCTION operations_audit();
CREATE TRIGGER inventory_movement_audit AFTER INSERT ON inventory_movement FOR EACH ROW EXECUTE FUNCTION operations_audit();

-- Restore suppresses business triggers while loading rows. Reconcile the
-- register to its immutable history before accepting the copied company.
CREATE FUNCTION operations_validate_ledger(l uuid) RETURNS void LANGUAGE plpgsql STABLE AS $$
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
       OR c.remaining_cost<>c.cost-(SELECT coalesce(sum(cost),0) FROM inventory_cost_allocation WHERE layer_id=c.id)))
    OR EXISTS(SELECT 1 FROM inventory_stock s JOIN inventory_item i ON i.id=s.item_id WHERE s.ledger_id=l AND (i.track_batches<>(s.batch<>'') OR i.track_serials<>(s.serial<>''))) THEN
      RAISE EXCEPTION 'INVENTORY_REGISTER_INCONSISTENT: Stock and FIFO costs must reconcile to movement history.';
  END IF;
  IF EXISTS(SELECT 1 FROM fixed_asset_activity x JOIN fixed_asset a ON a.id=x.asset_id WHERE x.ledger_id=l AND (x.activity_date<a.acquired_on OR x.activity_date>a.disposed_on)) THEN
    RAISE EXCEPTION 'ASSET_ACTIVITY_DATES_INCONSISTENT';
  END IF;
END $$;
