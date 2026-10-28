-- Folder access is an explicit per-person capability. Existing accounts start
-- without it, including administrators; a manager grants it in People.
ALTER TABLE app_user
  ADD COLUMN webdav_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN app_user.webdav_enabled IS
  'Whether this person may create and use WebDAV passwords; company/module grants still limit the files.';
