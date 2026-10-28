-- 0030 — a sales invoice goes to a customer, not to whoever is on the list
--
-- Why: docs/design/09-invoices.md, 「往来单位得和方向对得上」.
--
-- 0025/0026 require a journal line's party to hold SOME transacting role at that
-- company on that date. That is the ledger's rule and it is the right one for a
-- ledger: a line does not know whether it is a sale or a purchase.
--
-- An invoice does. And nothing checked it. The screen renders customers and
-- suppliers into one select as two groups, so a supplier is one click away on a
-- sales invoice — and it posts, because `supplier` is a transacting role and the
-- line-level rule is satisfied. The result is a receivable owed by somebody you
-- buy from, sitting in the aging under their name.
--
-- The rule belongs here rather than in the ledger for the same reason the
-- control-account rule does: it is about what kind of document this is.

CREATE OR REPLACE FUNCTION check_invoice_party_role() RETURNS trigger AS $$
DECLARE
  want text;
  who  text;
  held text;
BEGIN
  want := CASE WHEN NEW.direction = 'sales' THEN 'customer' ELSE 'supplier' END;

  IF EXISTS (
    SELECT 1 FROM party_role pr
     WHERE pr.party_id = NEW.party_id
       AND pr.entity_id = NEW.entity_id
       AND pr.role = want
       AND pr.held_from <= NEW.issued_on
       AND (pr.held_to IS NULL OR pr.held_to >= NEW.issued_on))
  THEN
    RETURN NULL;
  END IF;

  SELECT name INTO who FROM party WHERE id = NEW.party_id;

  -- Say what they ARE here, when they are something. "Not a customer" is
  -- unhelpful next to a list that offered them; "they are a supplier here" is
  -- the sentence that explains the mistake.
  SELECT string_agg(DISTINCT pr.role, ', ' ORDER BY pr.role) INTO held
    FROM party_role pr
   WHERE pr.party_id = NEW.party_id AND pr.entity_id = NEW.entity_id
     AND pr.held_from <= NEW.issued_on
     AND (pr.held_to IS NULL OR pr.held_to >= NEW.issued_on);

  -- Three placeholders, three values. The first version ended `%%`, which is a
  -- literal per cent rather than a slot, so it had one value too many and
  -- Postgres refused the migration outright. Better than a message with a
  -- stray sign in it.
  RAISE EXCEPTION 'INVOICE_PARTY_ROLE: % is not a % of this company on %',
    COALESCE(who, NEW.party_id::text), want,
    NEW.issued_on::text
      || CASE WHEN held IS NULL THEN '' ELSE ' — they are ' || held || ' here' END;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_invoice_party_role
  AFTER INSERT OR UPDATE ON invoice
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_invoice_party_role();
