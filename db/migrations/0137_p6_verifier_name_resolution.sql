-- Resolve PL/pgSQL record variables versus table aliases in the read-only verifier.
CREATE OR REPLACE FUNCTION audit_verify_v1() RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
#variable_conflict use_column
DECLARE h audit_chain_head; a audit_log; s audit_legacy_seal;
  seq bigint; prev text; issue jsonb; issues jsonb := '[]'; chains bigint := 0;
BEGIN
  SELECT * INTO s FROM audit_legacy_seal;
  IF s IS NULL OR s.row_count<>(SELECT count(*) FROM audit_log WHERE chain_id IS NULL)
     OR s.first_id IS DISTINCT FROM (SELECT min(id) FROM audit_log WHERE chain_id IS NULL)
     OR s.last_id IS DISTINCT FROM (SELECT max(id) FROM audit_log WHERE chain_id IS NULL)
     OR s.digest IS DISTINCT FROM audit_legacy_digest_v1() THEN
    issues := issues||jsonb_build_array(jsonb_build_object('scope','legacy','sequence',null,'type','legacy_seal'));
  END IF;
  IF EXISTS(SELECT 1 FROM audit_log a LEFT JOIN audit_chain_head h USING(chain_id)
    WHERE a.chain_id IS NOT NULL AND h.chain_id IS NULL) THEN
    issues := issues||jsonb_build_array(jsonb_build_object('scope','unknown','sequence',null,'type','missing_head'));
  END IF;
  FOR h IN SELECT * FROM audit_chain_head ORDER BY scope_key LOOP
    chains := chains+1; seq := 0; prev := repeat('0',64); issue := NULL;
    FOR a IN SELECT * FROM audit_log WHERE chain_id=h.chain_id ORDER BY chain_seq LOOP
      IF a.chain_seq IS DISTINCT FROM seq+1 THEN issue := jsonb_build_object('type','sequence');
      ELSIF a.previous_hash IS DISTINCT FROM prev THEN issue := jsonb_build_object('type','previous_hash');
      ELSIF a.hash_version IS DISTINCT FROM 1 THEN issue := jsonb_build_object('type','format');
      ELSIF audit_scope_key(a)<>h.scope_key OR a.entity_id IS DISTINCT FROM h.entity_id OR a.ledger_id IS DISTINCT FROM h.ledger_id THEN issue := jsonb_build_object('type','scope');
      ELSIF a.canonical_bytes IS DISTINCT FROM audit_event_v1(a) THEN issue := jsonb_build_object('type','display_payload');
      ELSIF a.event_hash IS DISTINCT FROM audit_hash_v1(a.canonical_bytes) THEN issue := jsonb_build_object('type','hash');
      END IF;
      IF issue IS NOT NULL THEN
        issues := issues||jsonb_build_array(issue||jsonb_build_object('scope',h.scope_key,'chainId',h.chain_id,'sequence',a.chain_seq::text,'auditId',a.id::text)); EXIT;
      END IF;
      seq := a.chain_seq; prev := a.event_hash;
    END LOOP;
    IF issue IS NULL AND (seq<>h.sequence OR prev<>h.hash) THEN
      issues := issues||jsonb_build_array(jsonb_build_object('scope',h.scope_key,'chainId',h.chain_id,'sequence',seq::text,'type','head'));
    END IF;
  END LOOP;
  RETURN jsonb_build_object('format','FigTree.audit.verification.v1','ok',jsonb_array_length(issues)=0,
    'chains',chains::text,'issues',issues,'legacyProtectedSince',s.sealed_at,
    'tailProof','No independent checkpoint supplied; same-database heads cannot prove tail completeness.');
END $$;

