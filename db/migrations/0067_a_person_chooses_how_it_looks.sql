-- 0067 — how the screen looks belongs to the person, not to the machine.
--
-- The owner asked for a second palette and for light / dark / follow the
-- system (2026-09-07). Both are choices a PERSON makes, and this system
-- already keeps a person's own things beside them — their modules, their AI
-- service and key. A cookie would have done it, and would have been forgotten
-- the first time they signed in from somewhere else.
--
-- Text with a CHECK rather than an enum: a third theme is an INSERT nowhere
-- and a new value here, and the same reasoning that keeps `accounting_standard`
-- a reference table rather than a CHECK constraint does not apply — these two
-- lists are read by the STYLESHEET, which cannot be extended at run time.
--
-- Defaults matter: every row that exists gets the palette the application
-- shipped with and follows the machine, which is exactly what it did before
-- this migration ran.

ALTER TABLE app_user
  ADD COLUMN theme text NOT NULL DEFAULT 'claude',
  ADD COLUMN appearance_mode text NOT NULL DEFAULT 'system';

ALTER TABLE app_user
  ADD CONSTRAINT app_user_theme_known CHECK (theme IN ('claude', 'figtree')),
  ADD CONSTRAINT app_user_mode_known CHECK (appearance_mode IN ('system', 'light', 'dark'));

COMMENT ON COLUMN app_user.theme IS
  'Which palette this person sees. The stylesheet holds the values; this holds the name.';
COMMENT ON COLUMN app_user.appearance_mode IS
  'light, dark, or system — system meaning the machine''s own setting.';
