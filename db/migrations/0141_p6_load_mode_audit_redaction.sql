-- Ensure new canonical payloads never retain credentials during portable history imports.
CREATE OR REPLACE FUNCTION audit_append_chain_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h audit_chain_head; key text;
BEGIN
  -- Load mode suppresses the earlier attribution trigger; new evidence must still be scrubbed.
  NEW.before := audit_redact(NEW.before); NEW.after := audit_redact(NEW.after); NEW.context := audit_redact(NEW.context);
  key := audit_scope_key(NEW);
  -- A unique row exists before locking: safe for concurrent first events too.
  INSERT INTO audit_chain_head(scope_key,entity_id,ledger_id)
    VALUES(key,NEW.entity_id,NEW.ledger_id) ON CONFLICT(scope_key) DO NOTHING;
  SELECT * INTO STRICT h FROM audit_chain_head WHERE scope_key=key FOR UPDATE;
  IF h.entity_id IS DISTINCT FROM NEW.entity_id OR h.ledger_id IS DISTINCT FROM NEW.ledger_id THEN
    RAISE EXCEPTION 'AUDIT_CHAIN_SCOPE';
  END IF;
  NEW.chain_id := h.chain_id; NEW.chain_seq := h.sequence+1;
  NEW.previous_hash := h.hash; NEW.hash_version := 1;
  NEW.correlation_id := coalesce(nullif(NEW.correlation_id,''),nullif(current_setting('app.audit_correlation',true),''),
    NEW.context->>'correlationId','tx:'||txid_current()::text);
  NEW.canonical_bytes := audit_event_v1(NEW);
  NEW.event_hash := audit_hash_v1(NEW.canonical_bytes);
  UPDATE audit_chain_head SET sequence=NEW.chain_seq,hash=NEW.event_hash WHERE chain_id=h.chain_id;
  RETURN NEW;
END $$;
