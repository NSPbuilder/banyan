-- 0047 — some paper never existed, and the reminder should believe the owner
--
-- Why: the owner (2026-09-03) — salaries, bank fees, depreciation: entries
-- that touch an expense account and will never have a receipt, because there
-- is none to have. The standing reminder (15-attachments.md) chased them
-- forever. The fix is a WAIVER: the owner's recorded judgment that this
-- entry needs no paper. That judgment is state, not something derivable, so
-- it gets a row — and being a row, it is reversible and audited, where a
-- "skip" that merely hid a banner line would be neither.
--
-- One waiver per entry, cascading with it; who and when, always. The
-- reminder excludes waived entries; everything else ignores waivers.

CREATE TABLE receipt_waiver (
  entry_id    uuid PRIMARY KEY REFERENCES journal_entry(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text NOT NULL DEFAULT 'system'
);
