-- Preserve source amounts without changing existing invoice or GL amounts.
-- NULL means the older document did not store this information; no backfill.
ALTER TABLE invoice_line
  ADD COLUMN input_amount bigint,
  ADD COLUMN input_inclusive boolean,
  ADD COLUMN gst_override bigint,
  ADD COLUMN pst_override bigint;

ALTER TABLE invoice_line ADD CONSTRAINT invoice_line_tax_input_check CHECK (
  (input_amount IS NULL AND input_inclusive IS NULL AND gst_override IS NULL AND pst_override IS NULL)
  OR
  (input_amount IS NOT NULL AND input_amount <> 0 AND input_inclusive IS NOT NULL
    AND generated_for IS NULL
    AND (gst_override IS NULL OR gst_override = 0 OR
      (COALESCE(tax_code IN ('GST', 'GST_PST'), false) AND
       ((input_amount > 0 AND gst_override > 0) OR (input_amount < 0 AND gst_override < 0))))
    AND (pst_override IS NULL OR pst_override = 0 OR
      (COALESCE(tax_code IN ('PST', 'GST_PST'), false) AND
       ((input_amount > 0 AND pst_override > 0) OR (input_amount < 0 AND pst_override < 0)))))
);
