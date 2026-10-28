-- Keep each person's Liquid Glass background choice with their other appearance settings.
ALTER TABLE app_user
  ADD COLUMN liquid_tint text NOT NULL DEFAULT '#5eb7ff';

ALTER TABLE app_user
  ADD CONSTRAINT app_user_liquid_tint_hex
  CHECK (liquid_tint ~ '^#[0-9a-fA-F]{6}$');

COMMENT ON COLUMN app_user.liquid_tint IS
  'Hex colour used for the Liquid Glass background. It has no effect on the other themes.';
