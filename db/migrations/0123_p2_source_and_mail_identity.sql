-- Append-only hardening: preserve source identity and approved customer scope.
CREATE FUNCTION p2_inbox_source_kept() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.entity_id,NEW.ledger_id,NEW.sha256,NEW.filename,NEW.mime,NEW.created_at)
      IS DISTINCT FROM (OLD.entity_id,OLD.ledger_id,OLD.sha256,OLD.filename,OLD.mime,OLD.created_at)
  THEN RAISE EXCEPTION 'P2_INBOX_SOURCE_IMMUTABLE'; END IF;
  IF OLD.status='converted' AND (NEW.corrections,NEW.duplicate_override,NEW.converted_at,NEW.converted_by,NEW.reading_id)
      IS DISTINCT FROM (OLD.corrections,OLD.duplicate_override,OLD.converted_at,OLD.converted_by,OLD.reading_id)
  THEN RAISE EXCEPTION 'P2_INBOX_REVIEW_IMMUTABLE'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER p2_inbox_source_kept BEFORE UPDATE ON inbox_item FOR EACH ROW EXECUTE FUNCTION p2_inbox_source_kept();
CREATE FUNCTION p2_mail_customer_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.invoice_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM invoice WHERE id=NEW.invoice_id AND party_id=NEW.party_id)
    OR NEW.reminder_rule_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM reminder_rule WHERE id=NEW.reminder_rule_id AND party_id=NEW.party_id)
  THEN RAISE EXCEPTION 'P2_MAIL_CUSTOMER_IDENTITY'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER p2_mail_customer_identity BEFORE INSERT OR UPDATE ON email_message FOR EACH ROW EXECUTE FUNCTION p2_mail_customer_identity();
