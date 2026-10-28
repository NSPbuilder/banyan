-- Deleting a draft's local request would allow another provider upload for the
-- same immutable document, losing the original request and its audit identity.
CREATE FUNCTION esign_request_keep_history() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ESIGN_IMMUTABLE: Signing request history cannot be deleted';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER esign_request_keep_history BEFORE DELETE ON esign_request
FOR EACH ROW EXECUTE FUNCTION esign_request_keep_history();
