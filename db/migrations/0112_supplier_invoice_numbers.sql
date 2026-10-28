-- Supplier-issued numbers are unique within that supplier. Sales numbering
-- remains company-wide; invoice and credit-note sequences remain independent.
DROP INDEX invoice_number_unique;
CREATE UNIQUE INDEX invoice_number_unique
  ON invoice(entity_id,document_kind,number)
  WHERE direction='sales' AND number IS NOT NULL;
CREATE UNIQUE INDEX purchase_invoice_number_unique
  ON invoice(entity_id,party_id,document_kind,number)
  WHERE direction='purchase' AND number IS NOT NULL;
