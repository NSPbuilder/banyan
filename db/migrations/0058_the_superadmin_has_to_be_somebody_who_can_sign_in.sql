-- 0058 — the superadmin has to be somebody who can sign in
--
-- Why: docs/design/17-users-and-access.md §9 — the critic's round on 0057
-- (2026-09-04). Two corrections to 0057; that file is applied and checksummed,
-- so they live here. (0057's header cites "17-who-you-are.md"; the file is
-- 17-users-and-access.md.)
--
-- ONE. 0057 promoted the EARLIEST owner to superadmin, active or not. 0053's
-- guard only ever promised that SOME active owner exists — not that the first
-- one made was still active. A database whose first owner had been signed off
-- came out of 0057 with no active superadmin, and from then on the new guard
-- refused every UPDATE app_user — sign-in writes last_seen_at — with no page
-- able to repair it. Promote the earliest ACTIVE owner where that happened,
-- and refuse to go on if there is still nobody: a hand repair is better than
-- a database that quietly locks everybody out at the next sign-in.
SET CONSTRAINTS ALL IMMEDIATE;

UPDATE app_user SET kind = 'superadmin'
 WHERE NOT EXISTS (SELECT 1 FROM app_user WHERE kind = 'superadmin' AND is_active)
   AND id = (SELECT id FROM app_user WHERE is_owner AND is_active
              ORDER BY created_at, id LIMIT 1);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM app_user)
     AND NOT EXISTS (SELECT 1 FROM app_user WHERE kind = 'superadmin' AND is_active) THEN
    RAISE EXCEPTION 'NO_SUPERADMIN: no active superadmin and no active owner to promote. '
                    'ALTER TABLE app_user DISABLE TRIGGER trg_keep_one_owner, reactivate '
                    'somebody, re-enable it, then migrate again.';
  END IF;
END $$;

-- TWO. The guard watches the two columns it is about. As 0053 wrote it, it
-- fired on every UPDATE — sign-in's last_seen_at included — which is how a
-- broken state locked everybody out instead of refusing only the change that
-- would have broken it. Same function, same deferral; narrower trigger.
DROP TRIGGER trg_keep_one_owner ON app_user;
CREATE CONSTRAINT TRIGGER trg_keep_one_owner
  AFTER UPDATE OF kind, is_active OR DELETE ON app_user
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION keep_one_owner();
