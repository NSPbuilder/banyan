-- 0089 — Liquid Glass is a third answer to how this person's screen looks.
--
-- The stylesheet and Settings list ship the name with this migration. Keep a
-- CHECK rather than accepting arbitrary strings: a stored theme the installed
-- application does not know would silently borrow another palette.

ALTER TABLE app_user
  DROP CONSTRAINT app_user_theme_known;

ALTER TABLE app_user
  ADD CONSTRAINT app_user_theme_known
  CHECK (theme IN ('claude', 'figtree', 'liquid'));

COMMENT ON COLUMN app_user.theme IS
  'Which palette this person sees: claude, figtree, or liquid. The stylesheet holds the values; this holds the name.';
