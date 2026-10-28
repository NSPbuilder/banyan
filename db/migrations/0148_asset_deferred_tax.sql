ALTER TABLE asset_cca_year ADD CONSTRAINT asset_cca_year_ledger_id UNIQUE(ledger_id,id);
ALTER TABLE asset_depreciation_policy ADD COLUMN opening_accumulated bigint NOT NULL DEFAULT 0 CHECK(opening_accumulated>=0);
CREATE TABLE asset_depreciation_policy_revision (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),ledger_id uuid NOT NULL REFERENCES ledger(id) ON DELETE CASCADE,asset_id uuid NOT NULL,
  effective_on date NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 10000),
  before_policy jsonb NOT NULL,after_policy jsonb NOT NULL,created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(ledger_id,asset_id) REFERENCES fixed_asset(ledger_id,id),UNIQUE(asset_id,effective_on),
  CHECK(before_policy ?& ARRAY['method','start_date','residual_value','life_months','annual_rate_bp','opening_accumulated','version']),
  CHECK(after_policy ?& ARRAY['method','start_date','residual_value','life_months','annual_rate_bp','opening_accumulated','version'])
);
CREATE TRIGGER asset_policy_revision_immutable BEFORE UPDATE OR DELETE ON asset_depreciation_policy_revision FOR EACH ROW EXECUTE FUNCTION operations_history_immutable();
CREATE TRIGGER asset_policy_revision_audit AFTER INSERT ON asset_depreciation_policy_revision FOR EACH ROW EXECUTE FUNCTION operations_audit();
CREATE TABLE asset_deferred_tax_review (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),ledger_id uuid NOT NULL REFERENCES ledger(id) ON DELETE CASCADE,
  pool_id uuid NOT NULL,cca_year_id uuid NOT NULL,previous_review_id uuid,reporting_date date NOT NULL,revision integer NOT NULL CHECK(revision>0),
  rate_bp integer NOT NULL CHECK(rate_bp BETWEEN 0 AND 10000),rate_note text NOT NULL CHECK(length(btrim(rate_note)) BETWEEN 1 AND 10000),
  book_value bigint NOT NULL CHECK(book_value>=0),closing_ucc bigint NOT NULL CHECK(closing_ucc>=0),pending_tax_cost bigint NOT NULL CHECK(pending_tax_cost>=0),
  book_adjustment bigint NOT NULL,tax_adjustment bigint NOT NULL,tax_base bigint NOT NULL CHECK(tax_base>=0),temporary_difference bigint NOT NULL,
  liability bigint NOT NULL CHECK(liability>=0),potential_asset bigint NOT NULL CHECK(potential_asset>=0),recognized_asset bigint NOT NULL CHECK(recognized_asset BETWEEN 0 AND potential_asset),
  previous_liability bigint NOT NULL CHECK(previous_liability>=0),previous_asset bigint NOT NULL CHECK(previous_asset>=0),
  recognition text NOT NULL CHECK(recognition IN ('profit_loss','oci','equity')),note text NOT NULL CHECK(length(btrim(note)) BETWEEN 1 AND 10000),
  policy_version text NOT NULL,calculation_snapshot jsonb NOT NULL,journal jsonb NOT NULL CHECK(jsonb_typeof(journal)='array'),
  request_key uuid NOT NULL,request_hash text NOT NULL,created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(ledger_id,id),UNIQUE(ledger_id,request_key),UNIQUE(pool_id,cca_year_id,revision),
  FOREIGN KEY(ledger_id,pool_id) REFERENCES asset_cca_pool(ledger_id,id),
  FOREIGN KEY(ledger_id,cca_year_id) REFERENCES asset_cca_year(ledger_id,id),
  FOREIGN KEY(ledger_id,previous_review_id) REFERENCES asset_deferred_tax_review(ledger_id,id),
  CHECK(book_value+book_adjustment>=0),CHECK(tax_base=closing_ucc+pending_tax_cost+tax_adjustment),
  CHECK(temporary_difference=book_value+book_adjustment-tax_base),
  CHECK(liability=floor((greatest(temporary_difference::numeric,0)*rate_bp+5000)/10000)),
  CHECK(potential_asset=floor((greatest(-temporary_difference::numeric,0)*rate_bp+5000)/10000))
);
CREATE TRIGGER asset_deferred_tax_immutable BEFORE UPDATE OR DELETE ON asset_deferred_tax_review FOR EACH ROW EXECUTE FUNCTION operations_history_immutable();
CREATE TRIGGER asset_deferred_tax_audit AFTER INSERT ON asset_deferred_tax_review FOR EACH ROW EXECUTE FUNCTION operations_audit();
ALTER FUNCTION operations_validate_ledger(uuid) RENAME TO operations_validate_book_tax_base;
CREATE FUNCTION operations_validate_ledger(l uuid) RETURNS void LANGUAGE plpgsql STABLE AS $$
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
CREATE CONSTRAINT TRIGGER asset_deferred_tax_balance AFTER INSERT ON asset_deferred_tax_review DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION asset_register_check();

-- An immutable review freezes book facts through its reporting date. Corrections
-- are reviewed basis adjustments or new dated book entries, never silent edits.
CREATE FUNCTION asset_tax_review_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cutoff date;aid uuid;
BEGIN
  IF TG_TABLE_NAME='fixed_asset' THEN aid:=NEW.id;
  ELSE aid:=NEW.asset_id;
  END IF;
  SELECT max(r.reporting_date) INTO cutoff FROM asset_deferred_tax_review r JOIN asset_cca_assignment x ON x.pool_id=r.pool_id WHERE x.asset_id=aid;
  IF cutoff IS NULL THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME='asset_depreciation_entry' THEN
    IF NEW.entry_date<=cutoff THEN RAISE EXCEPTION 'BOOK_TAX_REVIEW_HISTORY: use a later book entry or a reviewed basis adjustment'; END IF;
  ELSIF TG_TABLE_NAME='fixed_asset' THEN
    IF NEW.acquisition_cost<>OLD.acquisition_cost OR NEW.acquired_on<>OLD.acquired_on
      OR ((NEW.disposed_on IS DISTINCT FROM OLD.disposed_on OR NEW.disposal_proceeds<>OLD.disposal_proceeds) AND (NEW.disposed_on<=cutoff OR OLD.disposed_on<=cutoff)) THEN RAISE EXCEPTION 'BOOK_TAX_REVIEW_HISTORY: recorded book facts are fixed'; END IF;
  ELSE
    IF NEW.start_date<=cutoff OR (TG_OP='UPDATE' AND (NEW.asset_id<>OLD.asset_id OR NEW.ledger_id<>OLD.ledger_id))
      OR NOT EXISTS(SELECT 1 FROM asset_depreciation_policy_revision WHERE asset_id=NEW.asset_id AND effective_on=NEW.start_date) THEN
      RAISE EXCEPTION 'BOOK_TAX_REVIEW_HISTORY: use a prospective estimate review after the recorded date';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER asset_book_tax_entry_guard BEFORE INSERT ON asset_depreciation_entry FOR EACH ROW EXECUTE FUNCTION asset_tax_review_guard();
CREATE TRIGGER asset_book_tax_identity_guard BEFORE UPDATE ON fixed_asset FOR EACH ROW EXECUTE FUNCTION asset_tax_review_guard();
CREATE TRIGGER asset_book_tax_policy_guard BEFORE INSERT OR UPDATE ON asset_depreciation_policy FOR EACH ROW EXECUTE FUNCTION asset_tax_review_guard();

CREATE FUNCTION asset_tax_assignment_review_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cutoff date;acquired date;prior_assignment asset_cca_assignment%ROWTYPE;
BEGIN
  SELECT * INTO prior_assignment FROM asset_cca_assignment WHERE asset_id=NEW.asset_id;
  SELECT max(reporting_date) INTO cutoff FROM asset_deferred_tax_review WHERE pool_id=NEW.pool_id OR pool_id=prior_assignment.pool_id;
  IF cutoff IS NULL THEN RETURN NEW; END IF;
  SELECT acquired_on INTO acquired FROM fixed_asset WHERE id=NEW.asset_id;
  IF prior_assignment.id IS NULL THEN
    IF acquired<=cutoff THEN RAISE EXCEPTION 'BOOK_TAX_REVIEW_HISTORY: assignment changes recorded book scope'; END IF;
  ELSIF (TG_OP='UPDATE' AND NEW.asset_id<>OLD.asset_id) OR NEW.pool_id<>prior_assignment.pool_id OR NEW.tax_cost<>prior_assignment.tax_cost OR NEW.available_on<>prior_assignment.available_on OR NEW.first_year_rule<>prior_assignment.first_year_rule
    OR ((NEW.disposed_on IS DISTINCT FROM prior_assignment.disposed_on OR NEW.proceeds<>prior_assignment.proceeds) AND (NEW.disposed_on<=cutoff OR prior_assignment.disposed_on<=cutoff)) THEN
    RAISE EXCEPTION 'BOOK_TAX_REVIEW_HISTORY: recorded tax basis is fixed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER asset_tax_assignment_review_guard BEFORE INSERT OR UPDATE ON asset_cca_assignment FOR EACH ROW EXECUTE FUNCTION asset_tax_assignment_review_guard();

CREATE CONSTRAINT TRIGGER asset_policy_revision_balance AFTER INSERT ON asset_depreciation_policy_revision DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION asset_register_check();
