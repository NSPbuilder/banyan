-- A document/application change invalidates the durable quote immediately.
-- Provider cancellation happens outside accounting transactions in the worker.
CREATE FUNCTION p5_invalidate_invoice_checkout() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE checkout_request SET
    status=CASE WHEN stripe_checkout_id IS NULL THEN 'needs_accounting_review' ELSE 'invalidated' END,
    checkout_url=NULL
  WHERE invoice_id=NEW.id AND status IN ('creating','open');
  RETURN NEW;
END $$;
CREATE TRIGGER p5_invoice_checkout_changed AFTER UPDATE ON invoice
FOR EACH ROW WHEN (OLD.version IS DISTINCT FROM NEW.version OR OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION p5_invalidate_invoice_checkout();
