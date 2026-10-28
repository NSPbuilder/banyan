-- 0049 — the other side's number lives where the document does
--
-- Why: browsing expenses by party, the owner wants the SUPPLIER's own invoice
-- number on the line — the number you quote when they ring up about it
-- (owner, 2026-09-03). A bill already carries it: `invoice.their_ref`, filled
-- in when the bill was entered. A quick expense carries nothing, because a
-- quick expense HAS no document row: the journal entry is the document.
--
-- So the column lands on the entry, and a CHECK stops it from becoming a
-- second spelling of a number the invoice already holds — an entry raised BY
-- an invoice may not carry its own. One number, one home; `entriesByParty`
-- reads whichever home an entry has, and can therefore never show two.
--
-- Reversals and replacements inherit it, because they are the same paper: a
-- corrected receipt is still that receipt's number.

ALTER TABLE journal_entry ADD COLUMN document_ref text;

-- An empty string is not a number anybody can look up; it is a NULL that got
-- through a form. The same shape rule party_address puts on line1.
ALTER TABLE journal_entry ADD CONSTRAINT journal_entry_document_ref_shape
  CHECK (document_ref IS NULL OR length(trim(document_ref)) > 0);

ALTER TABLE journal_entry ADD CONSTRAINT journal_entry_document_ref_has_one_home
  CHECK (document_ref IS NULL OR source_type NOT IN ('ar_invoice', 'ap_bill'));

COMMENT ON COLUMN journal_entry.document_ref IS
  'The number the document behind this entry is known by, when no invoice row holds it: a supplier receipt, a statement, a cheque stub.';
