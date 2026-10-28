-- Restore may pause incomplete work. Active and cancelled histories retain their terminal state.
CREATE OR REPLACE FUNCTION p3_run_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM ledger WHERE id=NEW.ledger_id FOR UPDATE;
  IF TG_OP='INSERT' AND (EXISTS(SELECT 1 FROM journal_entry WHERE ledger_id=NEW.ledger_id)
    OR EXISTS(SELECT 1 FROM invoice WHERE ledger_id=NEW.ledger_id)
    OR EXISTS(SELECT 1 FROM bank_transaction b JOIN account a ON a.id=b.account_id WHERE a.entity_id=NEW.entity_id)
    OR EXISTS(SELECT 1 FROM bank_statement b JOIN account a ON a.id=b.account_id WHERE a.entity_id=NEW.entity_id))
    THEN RAISE EXCEPTION 'P3_TARGET_NOT_EMPTY'; END IF;
  IF NOT EXISTS(SELECT 1 FROM ledger l JOIN account a ON a.id=NEW.clearing_account_id
    WHERE l.id=NEW.ledger_id AND l.entity_id=NEW.entity_id AND a.entity_id=NEW.entity_id
      AND a.account_type='equity' AND a.is_active AND a.is_postable AND l.currency=NEW.currency)
    THEN RAISE EXCEPTION 'P3_RUN_SCOPE: target ledger/currency/clearing account does not match'; END IF;
  IF TG_OP='UPDATE' AND (NEW.ledger_id IS DISTINCT FROM OLD.ledger_id OR NEW.entity_id IS DISTINCT FROM OLD.entity_id
    OR NEW.mode IS DISTINCT FROM OLD.mode OR NEW.source_system IS DISTINCT FROM OLD.source_system
    OR NEW.source_company IS DISTINCT FROM OLD.source_company OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.from_date IS DISTINCT FROM OLD.from_date OR NEW.cutoff_date IS DISTINCT FROM OLD.cutoff_date
    OR NEW.clearing_account_id IS DISTINCT FROM OLD.clearing_account_id) THEN RAISE EXCEPTION 'P3_RUN_IDENTITY'; END IF;
  IF TG_OP='UPDATE' AND NEW.status='cancelled' AND EXISTS(SELECT 1 FROM migration_reference WHERE run_id=OLD.id)
    THEN RAISE EXCEPTION 'P3_COMMITTED_IMPORT_KEPT: a committed migration cannot be cancelled to reopen ordinary writes'; END IF;
  IF TG_OP='UPDATE' AND OLD.status='active' AND NEW.status<>'active' THEN RAISE EXCEPTION 'P3_ACTIVE_RUN_KEPT'; END IF;
  IF TG_OP='UPDATE' AND NEW.status<>OLD.status AND NOT (
    NEW.status='restored_paused' AND OLD.status NOT IN ('active','cancelled')
    OR OLD.status='draft' AND NEW.status IN ('validated','cancelled')
    OR OLD.status='validated' AND NEW.status IN ('draft','running','cancelled')
    OR OLD.status IN ('running','failed','restored_paused') AND NEW.status IN ('running','failed','ready')
    OR OLD.status='ready' AND NEW.status IN ('active','failed')) THEN RAISE EXCEPTION 'P3_RUN_TRANSITION'; END IF;
  RETURN NEW;
END $$;
