-- PostgreSQL \s depends on LC_CTYPE. Make pasted non-breaking spaces
-- deterministic on Linux/macOS while preserving the existing duplicate-name door.
CREATE OR REPLACE FUNCTION party_name_key(p_name text) RETURNS text AS $$
  SELECT trim(regexp_replace(lower(translate(p_name, chr(160) || chr(8239), '  ')), '\s+', ' ', 'g'));
$$ LANGUAGE sql IMMUTABLE;

-- Existing expression-index entries must use the new function. A pre-existing
-- collision rejects this migration transaction; never merge/delete a Party.
REINDEX INDEX party_one_active_name;
