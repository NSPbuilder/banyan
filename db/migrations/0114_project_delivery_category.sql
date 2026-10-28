-- Append-only: allow Delivery costs without reclassifying existing records.
ALTER TABLE project_record_line DROP CONSTRAINT project_record_line_kind_check;
ALTER TABLE project_record_line ADD CONSTRAINT project_record_line_kind_check
  CHECK (kind IN ('revenue','material','labor','janitorial','delivery','other'));
