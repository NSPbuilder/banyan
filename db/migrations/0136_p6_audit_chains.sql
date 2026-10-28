-- Add verification to the existing audit door. Migration runs in one transaction:
-- block inserts through the cutover so every event is legacy or chained.
LOCK TABLE audit_log IN ACCESS EXCLUSIVE MODE;

-- FigTree canonical v1: UTF-8, object keys in byte order, arrays in source order,
-- JSON string escaping, null/boolean retained, ALL JSON numbers encoded as exact
-- decimal strings. This avoids a JavaScript parse rounding bigint cents.
CREATE FUNCTION audit_canonical_v1(v jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE result text;
BEGIN
  CASE jsonb_typeof(v)
    WHEN 'object' THEN
      SELECT '{'||coalesce(string_agg(to_jsonb(key)::text||':'||audit_canonical_v1(value), ',' ORDER BY key COLLATE "C"),'')||'}'
        INTO result FROM jsonb_each(v);
    WHEN 'array' THEN
      SELECT '['||coalesce(string_agg(audit_canonical_v1(value), ',' ORDER BY n),'')||']'
        INTO result FROM jsonb_array_elements(v) WITH ORDINALITY x(value,n);
    WHEN 'number' THEN result := to_jsonb(v #>> '{}')::text;
    ELSE result := coalesce(v::text,'null');
  END CASE;
  RETURN result;
END $$;

ALTER TABLE audit_log ADD COLUMN chain_id uuid,
  ADD COLUMN chain_seq bigint,
  ADD COLUMN previous_hash text,
  ADD COLUMN event_hash text,
  ADD COLUMN canonical_bytes bytea,
  ADD COLUMN hash_version integer,
  ADD COLUMN source text NOT NULL DEFAULT 'database',
  ADD COLUMN correlation_id text;
CREATE UNIQUE INDEX audit_chain_sequence ON audit_log(chain_id,chain_seq);

CREATE TABLE audit_chain_head (
  chain_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_key text NOT NULL UNIQUE,
  entity_id uuid, ledger_id uuid,
  sequence bigint NOT NULL DEFAULT 0 CHECK(sequence>=0),
  hash text NOT NULL DEFAULT repeat('0',64) CHECK(hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION audit_scope_key(a audit_log) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN a.entity_id IS NOT NULL AND a.ledger_id IS NOT NULL THEN 'ledger:'||a.ledger_id::text
    WHEN a.entity_id IS NOT NULL THEN 'company:'||a.entity_id::text ELSE a.scope END
$$;

-- Every displayed attribution/target/payload field and the row ID participates.
-- UTC timestamps always contain six fractional digits, independent of TZ/GUCs.
CREATE FUNCTION audit_event_v1(a audit_log) RETURNS bytea LANGUAGE sql STABLE AS $$
  SELECT convert_to(audit_canonical_v1(jsonb_build_object(
    'formatVersion',a.hash_version::text,'chainId',a.chain_id::text,
    'scope',jsonb_build_object('key',audit_scope_key(a),'kind',a.scope,'entityId',a.entity_id,'ledgerId',a.ledger_id),
    'sequence',a.chain_seq::text,'previousHash',a.previous_hash,
    'occurredAt',to_char(a.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'actor',a.actor,'source',a.source,'correlationId',a.correlation_id,
    'action',a.action,'target',jsonb_build_object('auditId',a.id::text,'table',a.table_name,'id',a.record_id,'label',a.target_label),
    'payload',jsonb_build_object('before',a.before,'after',a.after,'context',a.context,'reason',a.reason)
  )),'UTF8')
$$;
CREATE FUNCTION audit_hash_v1(bytes bytea) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(digest(convert_to(E'FigTree.audit.v1\n','UTF8')||bytes,'sha256'),'hex')
$$;

CREATE TABLE audit_legacy_seal (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  first_id bigint, last_id bigint, row_count bigint NOT NULL,
  digest text NOT NULL, sealed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  format text NOT NULL DEFAULT 'FigTree.audit.legacy.v1'
);
CREATE FUNCTION audit_legacy_digest_v1() RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE a audit_log; h text := encode(digest('FigTree.audit.legacy.v1','sha256'),'hex');
BEGIN
  FOR a IN SELECT * FROM audit_log WHERE chain_id IS NULL ORDER BY id LOOP
    h := encode(digest(convert_to(h||audit_canonical_v1((to_jsonb(a)-ARRAY[
      'chain_id','chain_seq','previous_hash','event_hash','canonical_bytes','hash_version','source','correlation_id'
    ])||jsonb_build_object('occurred_at',to_char(a.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))),'UTF8'),'sha256'),'hex');
  END LOOP;
  RETURN h;
END $$;
INSERT INTO audit_legacy_seal(first_id,last_id,row_count,digest)
  SELECT min(id),max(id),count(*),audit_legacy_digest_v1() FROM audit_log;

CREATE FUNCTION audit_append_chain_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h audit_chain_head; key text;
BEGIN
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
-- PostgreSQL runs same-timing triggers by name: this is after trg_audit_actor.
CREATE TRIGGER zz_p6_audit_chain BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_append_chain_v1();
-- Portable restore intentionally suppresses business triggers, not audit.
ALTER TABLE audit_log ENABLE ALWAYS TRIGGER zz_p6_audit_chain;

CREATE TABLE audit_verification_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), checked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor text NOT NULL, result jsonb NOT NULL
);
CREATE TABLE audit_checkpoint (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor text NOT NULL, document jsonb NOT NULL
);
CREATE TABLE audit_origin_proof (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), entity_id uuid NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
  source_checksum text NOT NULL, proof jsonb NOT NULL, mapping jsonb NOT NULL,
  restored_at timestamptz NOT NULL DEFAULT clock_timestamp(), restored_by text NOT NULL
);
CREATE TRIGGER audit_seal_immutable BEFORE UPDATE OR DELETE ON audit_legacy_seal
  FOR EACH ROW EXECUTE FUNCTION forbid_audit_log_change();
CREATE TRIGGER audit_checkpoint_immutable BEFORE UPDATE OR DELETE ON audit_checkpoint
  FOR EACH ROW EXECUTE FUNCTION forbid_audit_log_change();

-- STABLE gives all reads the caller's statement snapshot. No repair writes.
CREATE FUNCTION audit_verify_v1() RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
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

INSERT INTO audit_log(actor,action,table_name,record_id,scope,after,source)
  SELECT 'migration:0136','seal_legacy','audit_log','legacy','system',
    jsonb_build_object('count',row_count::text,'firstId',first_id::text,'lastId',last_id::text,'digest',digest,
      'statement','Verifiable since this seal; no retroactive protection.'),'migration' FROM audit_legacy_seal;
