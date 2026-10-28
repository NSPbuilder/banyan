-- 0059 — exactly one superadmin
--
-- Why: docs/design/17-users-and-access.md §9. The owner's ruling on the three
-- questions 0057 left open (2026-09-04, "1不可以，2不能，3不保留"): ONE
-- superadmin, not several; a superadmin manages nobody of their own kind
-- (moot once there is one); an owner manages users only.
--
-- The library already refuses to make a second (mayAssign in user-kinds.ts);
-- this is the TABLE refusing the row, so a direct UPDATE cannot do what the
-- screen will not. A unique partial index is the whole mechanism; with 0053's
-- keep-one trigger (there is always an active one) that is exactly one.
SET CONSTRAINTS ALL IMMEDIATE;

-- Any extras made under the old rule step down to owner; the earliest ACTIVE
-- superadmin stays — 0058's rule for who holds the rung.
UPDATE app_user SET kind = 'owner'
 WHERE kind = 'superadmin'
   AND id <> (SELECT id FROM app_user WHERE kind = 'superadmin' AND is_active
               ORDER BY created_at, id LIMIT 1);

CREATE UNIQUE INDEX app_user_one_superadmin
  ON app_user (kind) WHERE kind = 'superadmin';

COMMENT ON INDEX app_user_one_superadmin IS
  'At most one row may be the superadmin (owner, 2026-09-04). The keep-one trigger '
  'makes it at least one that is active; together, exactly one.';
