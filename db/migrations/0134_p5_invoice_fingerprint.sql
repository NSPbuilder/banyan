-- Invoice versions also move when applications change. Preserve an immutable
-- document fingerprint so real receipts can become unapplied credit while a
-- corrected document still requires review. Old unknown quotes stay unverified.
ALTER TABLE checkout_request ADD COLUMN invoice_fingerprint text CHECK (invoice_fingerprint ~ '^[a-f0-9]{64}$');
CREATE FUNCTION p5_invoice_fingerprint(invoice_uuid uuid) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT encode(digest((to_jsonb(i)-ARRAY['version','updated_at'])::text || COALESCE(
    (SELECT jsonb_agg(to_jsonb(line) ORDER BY line.id)::text FROM invoice_line line WHERE line.invoice_id=i.id),'[]'),'sha256'),'hex')
  FROM invoice i WHERE i.id=invoice_uuid
$$;
