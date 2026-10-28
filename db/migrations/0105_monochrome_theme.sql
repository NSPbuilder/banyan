-- Add a neutral palette without changing anyone's existing appearance.
ALTER TABLE app_user DROP CONSTRAINT app_user_theme_known;

ALTER TABLE app_user
  ADD CONSTRAINT app_user_theme_known
  CHECK (theme IN ('claude', 'figtree', 'liquid', 'monochrome'));

COMMENT ON COLUMN app_user.theme IS
  'Which palette this person sees: claude, figtree, liquid, or monochrome. The stylesheet holds the values; this holds the name.';
