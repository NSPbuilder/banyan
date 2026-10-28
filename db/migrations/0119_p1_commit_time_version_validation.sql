-- A version-only UPDATE from a line trigger also queues the existing deferred
-- header check. Validate the COMMITTED header, not an intermediate OLD total.
-- All existing no-lines / net-zero / exact debit-credit checks remain intact.
CREATE OR REPLACE FUNCTION assert_entry_balanced_on_header() RETURNS trigger AS $$
DECLARE v_sum bigint; v_debit bigint; v_credit bigint; header journal_entry%ROWTYPE;
BEGIN
  SELECT * INTO header FROM journal_entry WHERE id=NEW.id;
  IF NOT FOUND OR header.status='draft' THEN RETURN NULL; END IF;
  SELECT COALESCE(SUM(amount),0),COALESCE(SUM(debit),0),COALESCE(SUM(credit),0)
    INTO v_sum,v_debit,v_credit FROM journal_line WHERE entry_id=header.id;
  IF NOT EXISTS(SELECT 1 FROM journal_line WHERE entry_id=header.id) THEN
    RAISE EXCEPTION 'Journal entry % has no lines',header.id;
  END IF;
  IF v_sum<>0 THEN RAISE EXCEPTION 'Journal entry % is out of balance by % cents',header.id,v_sum; END IF;
  IF header.total_debit<>v_debit OR header.total_credit<>v_credit THEN
    RAISE EXCEPTION 'Journal entry % header says debit %/credit % but its lines total debit %/credit %',
      header.id,header.total_debit,header.total_credit,v_debit,v_credit;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE FUNCTION p1_credit_application_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_entry uuid;
BEGIN
  FOR source_entry IN SELECT DISTINCT x FROM unnest(ARRAY[
    CASE WHEN TG_OP<>'INSERT' THEN OLD.entry_id END,
    CASE WHEN TG_OP<>'DELETE' THEN NEW.entry_id END]) x ORDER BY x LOOP
    UPDATE invoice SET version=version WHERE entry_id=source_entry;
  END LOOP;
  RETURN NULL;
END $$;
CREATE TRIGGER p1_credit_application_version AFTER INSERT OR UPDATE OR DELETE ON invoice_application
  FOR EACH ROW EXECUTE FUNCTION p1_credit_application_version();
