-- Scope is immutable; this is the invoice version originally shown when sharing.
ALTER TABLE portal_invitation ADD COLUMN issued_invoice_version bigint NOT NULL DEFAULT 1 CHECK (issued_invoice_version>0);
