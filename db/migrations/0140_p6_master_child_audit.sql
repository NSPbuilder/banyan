-- Selected shared master data must retain the values, not only a bumped parent.
CREATE FUNCTION audit_master_child_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b jsonb; a jsonb; target text;
BEGIN
  IF TG_OP<>'INSERT' THEN b:=to_jsonb(OLD); END IF;
  IF TG_OP<>'DELETE' THEN a:=to_jsonb(NEW); END IF;
  target:=coalesce(a->>'id',b->>'id');
  INSERT INTO audit_log(actor,action,table_name,record_id,before,after,scope,context)
    VALUES(coalesce(nullif(current_setting('app.actor',true),''),'system'),lower(TG_OP)||'_'||TG_TABLE_NAME,
      TG_TABLE_NAME,target,b,a,'shared',jsonb_build_object('partyId',coalesce(a->>'party_id',b->>'party_id')));
  RETURN NULL;
END $$;
CREATE TRIGGER p6_address_audit AFTER INSERT OR UPDATE OR DELETE ON party_address FOR EACH ROW EXECUTE FUNCTION audit_master_child_v1();
CREATE TRIGGER p6_contact_audit AFTER INSERT OR UPDATE OR DELETE ON party_contact FOR EACH ROW EXECUTE FUNCTION audit_master_child_v1();
CREATE TRIGGER audit_origin_no_update BEFORE UPDATE ON audit_origin_proof FOR EACH ROW EXECUTE FUNCTION forbid_audit_log_change();
