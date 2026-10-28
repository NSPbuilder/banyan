CREATE TABLE asset_depreciation_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),ledger_id uuid NOT NULL REFERENCES ledger(id) ON DELETE CASCADE,
  through_date date NOT NULL,entry_count integer NOT NULL CHECK(entry_count>=0),request_key uuid NOT NULL,request_hash text NOT NULL,
  created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(ledger_id,request_key)
);
CREATE TRIGGER asset_depreciation_run_immutable BEFORE UPDATE OR DELETE ON asset_depreciation_run FOR EACH ROW EXECUTE FUNCTION operations_history_immutable();
CREATE TRIGGER asset_depreciation_run_audit AFTER INSERT ON asset_depreciation_run FOR EACH ROW EXECUTE FUNCTION operations_audit();
CREATE TABLE asset_depreciation_policy (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),ledger_id uuid NOT NULL REFERENCES ledger(id) ON DELETE CASCADE,asset_id uuid NOT NULL,
  method text NOT NULL CHECK(method IN ('none','straight_line','declining_balance','manual')),
  start_date date NOT NULL,residual_value bigint NOT NULL DEFAULT 0 CHECK(residual_value>=0),
  life_months integer NOT NULL DEFAULT 60 CHECK(life_months BETWEEN 1 AND 1200),annual_rate_bp integer NOT NULL DEFAULT 2000 CHECK(annual_rate_bp BETWEEN 1 AND 10000),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),UNIQUE(ledger_id,asset_id),
  FOREIGN KEY(ledger_id,asset_id) REFERENCES fixed_asset(ledger_id,id)
);
CREATE TABLE asset_depreciation_entry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),ledger_id uuid NOT NULL REFERENCES ledger(id) ON DELETE CASCADE,asset_id uuid NOT NULL,
  entry_date date NOT NULL,period_start date,period_end date,kind text NOT NULL CHECK(kind IN ('automatic','manual')),
  amount bigint NOT NULL CHECK(amount<>0),note text NOT NULL CHECK(length(btrim(note)) BETWEEN 1 AND 10000),policy_snapshot jsonb NOT NULL DEFAULT '{}',
  request_key uuid NOT NULL,request_hash text NOT NULL,created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(ledger_id,asset_id) REFERENCES fixed_asset(ledger_id,id),UNIQUE(ledger_id,request_key),
  CHECK(kind<>'automatic' OR (amount>0 AND period_start IS NOT NULL AND period_end>=period_start AND entry_date=period_end))
);
CREATE UNIQUE INDEX asset_depreciation_month ON asset_depreciation_entry(asset_id,period_start) WHERE kind='automatic';
CREATE TABLE asset_cca_pool (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),ledger_id uuid NOT NULL REFERENCES ledger(id) ON DELETE CASCADE,
  name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 240),class_code text NOT NULL CHECK(length(btrim(class_code)) BETWEEN 1 AND 30),
  rate_bp integer NOT NULL CHECK(rate_bp BETWEEN 1 AND 10000),calculation text NOT NULL CHECK(calculation IN ('standard','manual')),
  opening_ucc bigint NOT NULL DEFAULT 0 CHECK(opening_ucc>=0),start_date date NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK(version>0),UNIQUE(ledger_id,id)
);
CREATE UNIQUE INDEX asset_cca_pool_name ON asset_cca_pool(ledger_id,lower(name));
CREATE TABLE asset_cca_assignment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),ledger_id uuid NOT NULL REFERENCES ledger(id) ON DELETE CASCADE,asset_id uuid NOT NULL,pool_id uuid NOT NULL,
  tax_cost bigint NOT NULL CHECK(tax_cost>=0),available_on date NOT NULL,
  first_year_rule text NOT NULL CHECK(first_year_rule IN ('half_year','no_half_year','aiip','riip','manual')),
  eligibility_note text NOT NULL DEFAULT '' CHECK(length(eligibility_note)<=10000),
  disposed_on date,proceeds bigint NOT NULL DEFAULT 0 CHECK(proceeds>=0),version integer NOT NULL DEFAULT 1 CHECK(version>0),
  FOREIGN KEY(ledger_id,asset_id) REFERENCES fixed_asset(ledger_id,id),FOREIGN KEY(ledger_id,pool_id) REFERENCES asset_cca_pool(ledger_id,id),
  UNIQUE(ledger_id,asset_id),CHECK(disposed_on IS NULL OR disposed_on>=available_on),CHECK(disposed_on IS NOT NULL OR proceeds=0)
);
CREATE TABLE asset_cca_year (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),ledger_id uuid NOT NULL REFERENCES ledger(id) ON DELETE CASCADE,pool_id uuid NOT NULL,
  start_date date NOT NULL,end_date date NOT NULL CHECK(end_date>=start_date AND end_date<=start_date+365),
  opening_ucc bigint NOT NULL CHECK(opening_ucc>=0),additions bigint NOT NULL CHECK(additions>=0),disposals bigint NOT NULL CHECK(disposals>=0),
  basis_adjustment bigint NOT NULL DEFAULT 0,maximum_cca bigint NOT NULL CHECK(maximum_cca>=0),claimed_cca bigint NOT NULL CHECK(claimed_cca BETWEEN 0 AND maximum_cca),
  recapture bigint NOT NULL CHECK(recapture>=0),terminal_loss bigint NOT NULL CHECK(terminal_loss>=0),closing_ucc bigint NOT NULL CHECK(closing_ucc>=0),
  note text NOT NULL DEFAULT '' CHECK(length(note)<=10000),calculation_snapshot jsonb NOT NULL,
  request_key uuid NOT NULL,request_hash text NOT NULL,created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(ledger_id,pool_id) REFERENCES asset_cca_pool(ledger_id,id),UNIQUE(ledger_id,request_key),UNIQUE(pool_id,start_date)
);
CREATE TRIGGER asset_depreciation_policy_audit AFTER INSERT OR UPDATE OR DELETE ON asset_depreciation_policy FOR EACH ROW EXECUTE FUNCTION operations_audit();
CREATE TRIGGER asset_depreciation_entry_audit AFTER INSERT ON asset_depreciation_entry FOR EACH ROW EXECUTE FUNCTION operations_audit();
CREATE TRIGGER asset_depreciation_entry_immutable BEFORE UPDATE OR DELETE ON asset_depreciation_entry FOR EACH ROW EXECUTE FUNCTION operations_history_immutable();
CREATE TRIGGER asset_cca_pool_audit AFTER INSERT OR UPDATE OR DELETE ON asset_cca_pool FOR EACH ROW EXECUTE FUNCTION operations_audit();
CREATE TRIGGER asset_cca_assignment_audit AFTER INSERT OR UPDATE OR DELETE ON asset_cca_assignment FOR EACH ROW EXECUTE FUNCTION operations_audit();
CREATE TRIGGER asset_cca_year_audit AFTER INSERT ON asset_cca_year FOR EACH ROW EXECUTE FUNCTION operations_audit();
CREATE TRIGGER asset_cca_year_immutable BEFORE UPDATE OR DELETE ON asset_cca_year FOR EACH ROW EXECUTE FUNCTION operations_history_immutable();

ALTER FUNCTION operations_validate_ledger(uuid) RENAME TO operations_validate_inventory;
CREATE FUNCTION operations_validate_ledger(l uuid) RETURNS void LANGUAGE plpgsql STABLE AS $$
BEGIN
  PERFORM operations_validate_inventory(l);
  IF EXISTS(SELECT 1 FROM fixed_asset a LEFT JOIN asset_depreciation_policy p ON p.asset_id=a.id WHERE a.ledger_id=l AND
    (coalesce(p.residual_value,0)>a.acquisition_cost OR p.start_date<a.acquired_on
      OR (SELECT coalesce(sum(amount),0) FROM asset_depreciation_entry WHERE asset_id=a.id)<0
      OR (SELECT coalesce(sum(amount),0) FROM asset_depreciation_entry WHERE asset_id=a.id)>a.acquisition_cost-coalesce(p.residual_value,0)))
    OR EXISTS(SELECT 1 FROM asset_depreciation_entry e JOIN fixed_asset a ON a.id=e.asset_id WHERE e.ledger_id=l AND (e.entry_date<a.acquired_on OR e.entry_date>a.disposed_on)) THEN RAISE EXCEPTION 'DEPRECIATION_REGISTER_INCONSISTENT'; END IF;
  IF EXISTS(SELECT 1 FROM (SELECT asset_id,sum(amount) OVER(PARTITION BY asset_id ORDER BY entry_date,created_at,id) AS running FROM asset_depreciation_entry WHERE ledger_id=l) e JOIN fixed_asset a ON a.id=e.asset_id LEFT JOIN asset_depreciation_policy p ON p.asset_id=a.id WHERE e.running<0 OR e.running>a.acquisition_cost-coalesce(p.residual_value,0)) THEN RAISE EXCEPTION 'DEPRECIATION_HISTORY_INCONSISTENT'; END IF;
  IF EXISTS(SELECT 1 FROM (SELECT y.*,lag(closing_ucc) OVER(PARTITION BY pool_id ORDER BY end_date) AS previous_closing,lag(end_date) OVER(PARTITION BY pool_id ORDER BY end_date) AS previous_end FROM asset_cca_year y WHERE ledger_id=l) y JOIN asset_cca_pool p ON p.id=y.pool_id WHERE y.opening_ucc<>coalesce(y.previous_closing,p.opening_ucc) OR y.start_date<>coalesce(y.previous_end+1,p.start_date)) THEN RAISE EXCEPTION 'CCA_YEAR_CONTINUITY_INCONSISTENT'; END IF;
  IF EXISTS(SELECT 1 FROM asset_cca_assignment x JOIN fixed_asset a ON a.id=x.asset_id WHERE x.ledger_id=l AND x.available_on<a.acquired_on) THEN RAISE EXCEPTION 'CCA_ASSET_DATES_INCONSISTENT'; END IF;
  IF EXISTS(SELECT 1 FROM asset_cca_year y WHERE y.ledger_id=l AND y.closing_ucc<>y.opening_ucc+y.additions-y.disposals+y.basis_adjustment-y.claimed_cca+y.recapture-y.terminal_loss)
    OR EXISTS(SELECT 1 FROM asset_cca_year y JOIN asset_cca_year z ON z.pool_id=y.pool_id AND z.id<>y.id WHERE y.ledger_id=l AND y.start_date<=z.end_date AND z.start_date<=y.end_date) THEN RAISE EXCEPTION 'CCA_REGISTER_INCONSISTENT'; END IF;
END $$;
CREATE FUNCTION asset_register_check() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM operations_validate_ledger(NEW.ledger_id); RETURN NULL; END $$;
CREATE CONSTRAINT TRIGGER asset_depreciation_balance AFTER INSERT ON asset_depreciation_entry DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION asset_register_check();
CREATE CONSTRAINT TRIGGER asset_cca_balance AFTER INSERT ON asset_cca_year DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION asset_register_check();

CREATE CONSTRAINT TRIGGER asset_policy_balance AFTER INSERT OR UPDATE ON asset_depreciation_policy DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION asset_register_check();
CREATE CONSTRAINT TRIGGER fixed_asset_depreciation_balance AFTER UPDATE ON fixed_asset DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION asset_register_check();
