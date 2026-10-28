-- Historical migrations still establish every legacy table. A compiled
-- assembly declares which modules its connections may initialize. Unset
-- settings retain the pre-assembly behavior for existing maintenance clients.
CREATE FUNCTION figtree_module_enabled(module_id text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('figtree.modules', true), ''), '*') = '*'
      OR module_id = ANY(string_to_array(current_setting('figtree.modules', true), ','))
$$;

CREATE OR REPLACE FUNCTION seed_crm_pipeline_on_entity() RETURNS trigger AS $$
BEGIN
  IF figtree_module_enabled('CRM') THEN
    PERFORM seed_crm_pipeline_for_entity(NEW.id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
