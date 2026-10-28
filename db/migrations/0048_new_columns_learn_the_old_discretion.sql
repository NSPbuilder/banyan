-- 0048 — the register's new columns learn the old discretion
--
-- Why: this week the CSR gained "Became holder"/"Ceased" and the transparency
-- register gained "Ceased" (BC's own templates want the dates) — but
-- `register_field_visibility` never heard of them, and `visibleFields`
-- defaults an unlisted field to VISIBLE. A public render of the CSR withheld
-- the holder's name and holding while showing the dates beside the blanks,
-- and a public transparency render carried a lone Ceased column on a page
-- whose every other field is private (critic, 2026-09-03).
--
-- The new fields take their siblings' visibility: transparency is private in
-- its entirety, and the CSR's dates are as private as the name and holding
-- they describe. CR25 renders both registers for a public audience and
-- refuses the columns.

INSERT INTO register_field_visibility (register, field, visibility) VALUES
  ('transparency',       'ceased_on',  'private'),
  ('central_securities', 'became_on',  'private'),
  ('central_securities', 'ceased_on',  'private');
