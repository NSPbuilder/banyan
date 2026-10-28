-- Keep applied migration checksums; generic triggers must read only fields present on their table.
CREATE OR REPLACE FUNCTION p3_stage_owner() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; state text; company uuid;
BEGIN
  IF TG_OP='UPDATE' AND (to_jsonb(NEW)->>'run_id' IS DISTINCT FROM to_jsonb(OLD)->>'run_id'
    OR to_jsonb(NEW)->>'file_id' IS DISTINCT FROM to_jsonb(OLD)->>'file_id') THEN RAISE EXCEPTION 'P3_SOURCE_OWNER_KEPT'; END IF;
  IF TG_TABLE_NAME='migration_stage' THEN SELECT f.run_id INTO target FROM migration_file f WHERE f.id=COALESCE(NEW.file_id,OLD.file_id);
  ELSE target=COALESCE(NEW.run_id,OLD.run_id); END IF;
  -- The parent file DELETE already checked the run before its FK cascade.
  IF TG_TABLE_NAME='migration_stage' AND TG_OP='DELETE' AND target IS NULL THEN RETURN OLD; END IF;
  SELECT status,entity_id INTO state,company FROM migration_run WHERE id=target FOR UPDATE;
  IF state IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'P3_STAGING_FROZEN'; END IF;
  IF TG_OP<>'DELETE' AND TG_TABLE_NAME='migration_account_map' AND NOT EXISTS(SELECT 1 FROM account WHERE id=(to_jsonb(NEW)->>'target_account_id')::uuid AND entity_id=company AND is_active AND is_postable)
    THEN RAISE EXCEPTION 'P3_ACCOUNT_MAP_SCOPE'; END IF;
  IF TG_OP<>'DELETE' AND TG_TABLE_NAME='migration_party_map' AND NOT EXISTS(SELECT 1 FROM party_role WHERE party_id=(to_jsonb(NEW)->>'target_party_id')::uuid AND entity_id=company AND role IN ('customer','supplier'))
    THEN RAISE EXCEPTION 'P3_PARTY_MAP_SCOPE'; END IF;
  RETURN COALESCE(NEW,OLD);
END $$;
