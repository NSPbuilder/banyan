-- Expand the existing strict one-resource lease; retain every old check.
ALTER TABLE recurring_template ADD COLUMN day_of_month integer NOT NULL DEFAULT 1 CHECK (day_of_month BETWEEN 1 AND 31);
ALTER TABLE recurring_occurrence ADD COLUMN template_snapshot jsonb NOT NULL DEFAULT '{}';
ALTER TABLE recurring_occurrence ADD COLUMN timezone text NOT NULL DEFAULT 'America/Vancouver';
CREATE TRIGGER p2_recurring_version BEFORE UPDATE ON recurring_template FOR EACH ROW EXECUTE FUNCTION p1_bump_version();
CREATE TRIGGER p2_inbox_version BEFORE UPDATE ON inbox_item FOR EACH ROW EXECUTE FUNCTION p1_bump_version();
CREATE TRIGGER p2_reminder_version BEFORE UPDATE ON reminder_rule FOR EACH ROW EXECUTE FUNCTION p1_bump_version();
CREATE UNIQUE INDEX inbox_one_reading ON inbox_item(reading_id) WHERE reading_id IS NOT NULL;
ALTER TABLE document_edit_lease
  ADD COLUMN inbox_item_id uuid UNIQUE REFERENCES inbox_item(id) ON DELETE CASCADE,
  ADD COLUMN recurring_template_id uuid UNIQUE REFERENCES recurring_template(id) ON DELETE CASCADE,
  ADD COLUMN reminder_rule_id uuid UNIQUE REFERENCES reminder_rule(id) ON DELETE CASCADE;
ALTER TABLE document_edit_lease DROP CONSTRAINT document_edit_lease_check;
ALTER TABLE document_edit_lease ADD CONSTRAINT document_edit_lease_one_resource
  CHECK (num_nonnulls(invoice_id,journal_entry_id,inbox_item_id,recurring_template_id,reminder_rule_id)=1);
CREATE OR REPLACE FUNCTION p1_lease_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.invoice_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM invoice WHERE id=NEW.invoice_id AND ledger_id=NEW.ledger_id)
    OR NEW.journal_entry_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM journal_entry WHERE id=NEW.journal_entry_id AND ledger_id=NEW.ledger_id)
    OR NEW.inbox_item_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM inbox_item WHERE id=NEW.inbox_item_id AND ledger_id=NEW.ledger_id)
    OR NEW.recurring_template_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM recurring_template WHERE id=NEW.recurring_template_id AND ledger_id=NEW.ledger_id)
    OR NEW.reminder_rule_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM reminder_rule WHERE id=NEW.reminder_rule_id AND ledger_id=NEW.ledger_id)
  THEN RAISE EXCEPTION 'EDIT_LEASE_SCOPE'; END IF;
  IF NOT EXISTS (SELECT 1 FROM user_session WHERE token_hash=NEW.session_hash AND user_id=NEW.holder_user_id)
  THEN RAISE EXCEPTION 'EDIT_LEASE_SESSION'; END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION p2_customer_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM party_role WHERE party_id=NEW.party_id AND entity_id=NEW.entity_id AND role='customer')
  THEN RAISE EXCEPTION 'P2_CUSTOMER_ENTITY'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER p2_customer_scope BEFORE INSERT OR UPDATE ON reminder_rule FOR EACH ROW EXECUTE FUNCTION p2_customer_scope();
CREATE TRIGGER p2_customer_scope BEFORE INSERT OR UPDATE ON email_message FOR EACH ROW EXECUTE FUNCTION p2_customer_scope();
CREATE FUNCTION p2_reading_target_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.used_invoice_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM invoice WHERE id=NEW.used_invoice_id AND ledger_id=NEW.ledger_id)
  THEN RAISE EXCEPTION 'P2_READING_INVOICE_LEDGER'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER p2_reading_target_scope BEFORE INSERT OR UPDATE ON ai_bill_reading FOR EACH ROW EXECUTE FUNCTION p2_reading_target_scope();

ALTER TABLE background_job ADD COLUMN worker_id uuid REFERENCES automation_worker(id) ON DELETE SET NULL;

CREATE FUNCTION p2_inbox_final() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status='converted' AND (NEW.status<>'converted' OR
      NEW.target_invoice_id IS DISTINCT FROM OLD.target_invoice_id AND (NEW.target_invoice_id IS NOT NULL OR EXISTS(SELECT 1 FROM invoice WHERE id=OLD.target_invoice_id)) OR
      NEW.target_entry_id IS DISTINCT FROM OLD.target_entry_id AND (NEW.target_entry_id IS NOT NULL OR EXISTS(SELECT 1 FROM journal_entry WHERE id=OLD.target_entry_id)))
  THEN RAISE EXCEPTION 'P2_INBOX_ALREADY_CONVERTED'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER p2_inbox_final BEFORE UPDATE ON inbox_item FOR EACH ROW EXECUTE FUNCTION p2_inbox_final();
CREATE FUNCTION p2_reading_claim() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner uuid;
BEGIN
  SELECT id INTO owner FROM inbox_item WHERE reading_id=OLD.id;
  IF TG_OP='DELETE' THEN
    IF owner IS NOT NULL OR OLD.used_invoice_id IS NOT NULL THEN RAISE EXCEPTION 'P2_READING_KEPT'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.used_invoice_id IS NOT NULL AND NEW.used_invoice_id IS NOT NULL AND NEW.used_invoice_id<>OLD.used_invoice_id THEN RAISE EXCEPTION 'P2_READING_ALREADY_USED'; END IF;
  IF owner IS NOT NULL AND (NEW.used_entry_id IS DISTINCT FROM OLD.used_entry_id AND NEW.used_entry_id IS NOT NULL OR
      NEW.used_invoice_id IS DISTINCT FROM OLD.used_invoice_id AND NEW.used_invoice_id IS NOT NULL)
    AND current_setting('p2.inbox_claim',true) IS DISTINCT FROM owner::text THEN RAISE EXCEPTION 'P2_READING_INBOX_OWNER'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER p2_reading_claim BEFORE UPDATE OR DELETE ON ai_bill_reading FOR EACH ROW EXECUTE FUNCTION p2_reading_claim();

CREATE FUNCTION p2_mail_snapshot_kept() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-ARRAY['status','message_id','last_error','accepted_at','actor_user_id','invoice_id','reminder_rule_id','parent_message_id'])
     IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','message_id','last_error','accepted_at','actor_user_id','invoice_id','reminder_rule_id','parent_message_id'])
    THEN RAISE EXCEPTION 'P2_MAIL_SNAPSHOT_IMMUTABLE'; END IF;
  IF (NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id AND (NEW.actor_user_id IS NOT NULL OR EXISTS(SELECT 1 FROM app_user WHERE id=OLD.actor_user_id)))
    OR (NEW.invoice_id IS DISTINCT FROM OLD.invoice_id AND (NEW.invoice_id IS NOT NULL OR EXISTS(SELECT 1 FROM invoice WHERE id=OLD.invoice_id)))
    OR (NEW.reminder_rule_id IS DISTINCT FROM OLD.reminder_rule_id AND (NEW.reminder_rule_id IS NOT NULL OR EXISTS(SELECT 1 FROM reminder_rule WHERE id=OLD.reminder_rule_id)))
    OR (NEW.parent_message_id IS DISTINCT FROM OLD.parent_message_id AND (NEW.parent_message_id IS NOT NULL OR EXISTS(SELECT 1 FROM email_message WHERE id=OLD.parent_message_id)))
    THEN RAISE EXCEPTION 'P2_MAIL_REFERENCE_IMMUTABLE'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER p2_mail_snapshot_kept BEFORE UPDATE ON email_message FOR EACH ROW EXECUTE FUNCTION p2_mail_snapshot_kept();
