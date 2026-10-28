-- 0046 — a receipt binds to the ENTRY, and a file exists once
--
-- Why: the owner (2026-09-02) wants receipts filed per account per month
-- without storing a file twice — and one entry touches two accounts or more,
-- which is the whole tension. Resolution, in this repository's own idiom:
-- the TRUTH is stored once and the folders are derived. An attachment row
-- binds a content-addressed blob (sha256) to a journal ENTRY; the entry
-- already names every account it touched, so the expense account and the
-- bank account "have" the same receipt through one row. The per-account,
-- per-month Finder tree is a hardlink CACHE maintained by the application
-- (rebuildable, integrity-checked — period_balance's pattern on disk).
--
-- Deliberately NOT here:
--   * no NOT NULL attachment requirement anywhere — receipts arrive late,
--     and the owner chose a standing reminder over a gate;
--   * no per-account attachment table — that would be the duplication;
--   * no file bytes in the database — files live in the per-company store,
--     named by their hash; the byte_size and sha here let a sweep prove the
--     store still holds what the books think it holds.
--
-- ON DELETE CASCADE: deleting an entry (open-books door) removes the BINDING;
-- the blob file stays on disk — a receipt is paper, and paper survives a
-- bookkeeping correction. Orphaned blobs are reported, never auto-deleted.

CREATE TABLE attachment_blob (
  sha256      text PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  byte_size   bigint NOT NULL CHECK (byte_size > 0),
  mime        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text NOT NULL DEFAULT 'system'
);

CREATE TABLE attachment (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id    uuid NOT NULL REFERENCES journal_entry(id) ON DELETE CASCADE,
  sha256      text NOT NULL REFERENCES attachment_blob(sha256),
  filename    text NOT NULL CHECK (length(filename) BETWEEN 1 AND 255),
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text NOT NULL DEFAULT 'system',
  -- The same file on the same entry twice adds nothing a reader can use.
  CONSTRAINT attachment_once_per_entry UNIQUE (entry_id, sha256)
);

CREATE INDEX attachment_entry_idx ON attachment (entry_id);
