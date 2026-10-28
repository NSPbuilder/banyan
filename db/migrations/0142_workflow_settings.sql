-- Existing company Automation settings gain SMTP and a shared reminder schedule.
-- Existing per-customer schedules remain independent until explicitly changed.
CREATE FUNCTION valid_company_reminder_days(days integer[]) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT cardinality(days) BETWEEN 1 AND 12
    AND NOT EXISTS (SELECT 1 FROM unnest(days) d WHERE d IS NULL OR d<1 OR d>365)
    AND cardinality(days)=(SELECT count(DISTINCT d) FROM unnest(days) d)
$$;
ALTER TABLE automation_setting
  ADD COLUMN smtp_host text,
  ADD COLUMN smtp_port integer NOT NULL DEFAULT 587 CHECK (smtp_port BETWEEN 1 AND 65535),
  ADD COLUMN smtp_secure boolean NOT NULL DEFAULT false,
  ADD COLUMN smtp_username text,
  ADD COLUMN smtp_password_ciphertext bytea,
  ADD COLUMN reminder_days integer[] NOT NULL DEFAULT '{3,7,14}',
  ADD COLUMN reminder_start_hour integer NOT NULL DEFAULT 9 CHECK (reminder_start_hour BETWEEN 0 AND 23),
  ADD COLUMN reminder_end_hour integer NOT NULL DEFAULT 17 CHECK (reminder_end_hour BETWEEN 1 AND 24),
  ADD CONSTRAINT company_reminder_window CHECK (reminder_end_hour>reminder_start_hour),
  ADD CONSTRAINT company_reminder_days CHECK (valid_company_reminder_days(reminder_days)),
  ADD CONSTRAINT company_smtp_identity CHECK (smtp_password_ciphertext IS NULL OR smtp_host IS NOT NULL AND smtp_username IS NOT NULL);
ALTER TABLE reminder_rule ADD COLUMN uses_company_defaults boolean NOT NULL DEFAULT false;
