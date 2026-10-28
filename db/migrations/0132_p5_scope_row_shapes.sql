-- Real P5SC01 exposed heterogeneous NEW-field binding (42703). Read optional generic fields from row JSON.
CREATE OR REPLACE FUNCTION assert_p5_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r jsonb:=to_jsonb(NEW); linked_ledger uuid;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM ledger WHERE id=NEW.ledger_id AND entity_id=NEW.entity_id) THEN RAISE EXCEPTION 'P5_LEDGER_ENTITY'; END IF;
  FOR linked_ledger IN
    SELECT ledger_id FROM invoice WHERE id=(r->>'invoice_id')::uuid
    UNION ALL SELECT ledger_id FROM journal_entry WHERE id=(r->>'entry_id')::uuid
    UNION ALL SELECT ledger_id FROM payment_connection WHERE id=(r->>'payment_connection_id')::uuid
    UNION ALL SELECT ledger_id FROM inbound_connection WHERE id=(r->>'inbound_connection_id')::uuid
    UNION ALL SELECT ledger_id FROM portal_invitation WHERE id=(r->>'portal_invitation_id')::uuid
    UNION ALL SELECT ledger_id FROM checkout_request WHERE id=(r->>'checkout_request_id')::uuid
    UNION ALL SELECT ledger_id FROM payment_event WHERE id=(r->>'payment_event_id')::uuid
    UNION ALL SELECT ledger_id FROM inbound_message WHERE id=(r->>'inbound_message_id')::uuid
    UNION ALL SELECT ledger_id FROM inbox_item WHERE id=(r->>'inbox_item_id')::uuid
  LOOP IF linked_ledger<>NEW.ledger_id THEN RAISE EXCEPTION 'P5_REFERENCE_LEDGER'; END IF; END LOOP;
  IF r->>'party_id' IS NOT NULL AND r->>'invoice_id' IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM invoice WHERE id=(r->>'invoice_id')::uuid AND party_id=(r->>'party_id')::uuid) THEN RAISE EXCEPTION 'P5_INVOICE_PARTY'; END IF;
  IF TG_TABLE_NAME='payment_connection' THEN
    IF NOT EXISTS(SELECT 1 FROM account WHERE id=NEW.clearing_account_id AND entity_id=NEW.entity_id AND account_type='asset' AND is_active AND is_postable)
      OR NOT EXISTS(SELECT 1 FROM account WHERE id=NEW.fee_account_id AND entity_id=NEW.entity_id AND account_type='expense' AND is_active AND is_postable)
      OR NEW.clearing_account_id=NEW.fee_account_id THEN RAISE EXCEPTION 'P5_ACCOUNT_MAPPING'; END IF;
    IF NEW.bank_account_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM account a JOIN account_role ar ON ar.account_id=a.id
      WHERE a.id=NEW.bank_account_id AND a.entity_id=NEW.entity_id AND a.is_active AND ar.role='cash_and_cash_equivalents') THEN RAISE EXCEPTION 'P5_BANK_ACCOUNT'; END IF;
    IF EXISTS(SELECT 1 FROM account_role WHERE account_id=NEW.clearing_account_id AND role IN ('trade_receivables','trade_payables')) THEN RAISE EXCEPTION 'P5_CLEARING_CONTROL'; END IF;
    IF TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM checkout_request WHERE payment_connection_id=OLD.id AND status<>'detached')
      AND (NEW.stripe_account_id,NEW.mode,NEW.currency,NEW.clearing_account_id,NEW.fee_account_id)
        IS DISTINCT FROM (OLD.stripe_account_id,OLD.mode,OLD.currency,OLD.clearing_account_id,OLD.fee_account_id) THEN RAISE EXCEPTION 'P5_FROZEN_BINDING'; END IF;
  END IF;
  IF TG_OP='UPDATE' AND (NEW.entity_id,NEW.ledger_id) IS DISTINCT FROM (OLD.entity_id,OLD.ledger_id) THEN RAISE EXCEPTION 'P5_IDENTITY'; END IF;
  IF TG_OP='UPDATE' AND TG_TABLE_NAME IN ('portal_invitation','portal_session')
    AND (to_jsonb(NEW)-ARRAY['revoked_at','expires_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['revoked_at','expires_at']) THEN RAISE EXCEPTION 'P5_CAPABILITY_SCOPE'; END IF;
  IF TG_OP='UPDATE' AND TG_TABLE_NAME IN ('portal_invitation','portal_session')
    AND ((r->>'expires_at')::timestamptz>(to_jsonb(OLD)->>'expires_at')::timestamptz OR (to_jsonb(OLD)->>'revoked_at' IS NOT NULL AND r->>'revoked_at' IS NULL)) THEN RAISE EXCEPTION 'P5_CAPABILITY_REVOCATION'; END IF;
  IF TG_OP='UPDATE' AND TG_TABLE_NAME='checkout_request'
    AND (to_jsonb(NEW)-ARRAY['status','stripe_checkout_id','payment_intent_id','checkout_url','expires_at','last_error','updated_at'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','stripe_checkout_id','payment_intent_id','checkout_url','expires_at','last_error','updated_at']) THEN RAISE EXCEPTION 'P5_REQUEST_SCOPE'; END IF;
  IF TG_TABLE_NAME='portal_invitation' AND TG_OP='INSERT' AND NOT EXISTS(SELECT 1 FROM invoice
    WHERE id=(r->>'invoice_id')::uuid AND status='posted' AND direction='sales' AND document_kind='invoice') THEN RAISE EXCEPTION 'P5_PUBLIC_INVOICE'; END IF;
  RETURN NEW;
END $$;
