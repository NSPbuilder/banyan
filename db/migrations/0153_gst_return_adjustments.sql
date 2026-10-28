-- Working-copy overrides do not change journal lines or imply a filed return.
CREATE TABLE gst_return_adjustment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_id uuid NOT NULL REFERENCES ledger(id) ON DELETE CASCADE,
  from_date date NOT NULL,
  to_date date NOT NULL CHECK (to_date >= from_date),
  sales bigint,
  collected bigint,
  itcs bigint,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 4000),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by text NOT NULL,
  UNIQUE (ledger_id, from_date, to_date)
);

CREATE FUNCTION audit_gst_return_adjustment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE company uuid;
BEGIN
  SELECT entity_id INTO company FROM ledger WHERE id=NEW.ledger_id;
  INSERT INTO audit_log(actor, action, table_name, record_id, before, after,
                        entity_id, ledger_id, scope, reason, target_label)
  VALUES (coalesce(nullif(current_setting('app.actor',true),''),current_user),
          'adjust_gst_return', 'gst_return_adjustment', NEW.id::text,
          CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) || jsonb_build_object(
            'sales',OLD.sales::text,'collected',OLD.collected::text,'itcs',OLD.itcs::text) ELSE NULL END,
          to_jsonb(NEW) || jsonb_build_object('sales',NEW.sales::text,
            'collected',NEW.collected::text,'itcs',NEW.itcs::text),
          company, NEW.ledger_id, 'company', NEW.reason,
          'GST/HST '||NEW.from_date::text||' to '||NEW.to_date::text);
  RETURN NEW;
END $$;
CREATE TRIGGER gst_return_adjustment_audit AFTER INSERT OR UPDATE
  ON gst_return_adjustment FOR EACH ROW EXECUTE FUNCTION audit_gst_return_adjustment();
