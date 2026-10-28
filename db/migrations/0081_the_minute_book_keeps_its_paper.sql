-- 0081 — the minute book keeps its paper.
--
-- The owner, trying the add forms (2026-09-16): 「minutebook 是否也可以纳入附件
-- 管理？」. A minute-book row said THAT a resolution exists and where it is kept
-- (0035) — a line of free text — and the PDF a model had read it from stayed on
-- the reading, out of the attachment store, out of the company's Finder folder,
-- and attached to nothing.
--
-- Attachments (0046) bind a content-addressed blob to a journal ENTRY, and a
-- dozen readers lean on that: the account/month tree, the missing-receipt
-- chase, the entry's panel, the SR&ED evidence link. A minute-book record is
-- not an entry, so rather than loosen `attachment.entry_id` under all of them,
-- the minute book gets a binding of its own onto the SAME blobs: one file, one
-- hash, one blob — whether a receipt or a resolution names it.
--
-- Deleting the record takes its bindings with it; the blob stays, as it does
-- when a receipt is unfiled (docs/design/15). Attach and detach are audited by
-- the library, in the attachment rows' own words.

CREATE TABLE minute_book_attachment (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  minute_book_entry_id uuid NOT NULL REFERENCES minute_book_entry(id) ON DELETE CASCADE,
  sha256               text NOT NULL REFERENCES attachment_blob(sha256),
  filename             text NOT NULL CHECK (length(filename) BETWEEN 1 AND 255),
  note                 text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           text NOT NULL DEFAULT 'system',
  -- The same file on the same record twice adds nothing a reader can use.
  CONSTRAINT minute_book_attachment_once UNIQUE (minute_book_entry_id, sha256)
);

CREATE INDEX minute_book_attachment_entry_idx ON minute_book_attachment (minute_book_entry_id);

COMMENT ON TABLE minute_book_attachment IS
  'A document filed against a minute-book record, on the same content-addressed blobs as '
  'journal-entry attachments (0046). Its Finder view is <company>/Minute book/<year>/ (0081).';
