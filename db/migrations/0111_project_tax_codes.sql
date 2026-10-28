-- Legacy lines retain their entered tax amounts; new forms save the chosen tag.
ALTER TABLE project_record_line ADD COLUMN tax_code text
  CHECK (tax_code IN ('GST','PST','GST_PST','OUT_OF_SCOPE'));
