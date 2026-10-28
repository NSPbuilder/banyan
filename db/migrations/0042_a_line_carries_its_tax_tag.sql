-- Tags on invoice lines (docs/design/14-open-books.md §4).
--
-- `tax_code` is what the person SAID about a line — GST / PST / GST+PST /
-- out of scope. The derived tax lines the save generates from those tags
-- carry `generated_for`, so an edit can drop and recompute exactly them and
-- never touch a line a person typed. Tax remains an ordinary journal line
-- (0031 stands); these two columns are provenance, not arithmetic.

ALTER TABLE invoice_line ADD COLUMN tax_code text
  CHECK (tax_code IN ('GST','PST','GST_PST','OUT_OF_SCOPE'));
ALTER TABLE invoice_line ADD COLUMN generated_for text
  CHECK (generated_for IN ('GST','PST'));
