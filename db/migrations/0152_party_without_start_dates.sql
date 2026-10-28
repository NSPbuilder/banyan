-- Party registration has no first usable day. Keep existing held_from values
-- as legacy facts; new roles do not need one. End dates and company/role scope
-- still protect transactions and already recorded history.
ALTER TABLE party_role ALTER COLUMN held_from DROP NOT NULL;
ALTER TABLE party_role DROP CONSTRAINT party_role_check;
ALTER TABLE party_role DROP CONSTRAINT party_role_no_overlap;
CREATE UNIQUE INDEX party_role_one_current
  ON party_role (party_id, entity_id, role) WHERE held_to IS NULL;

CREATE OR REPLACE FUNCTION party_may_transact(p_party uuid, p_entity uuid, p_on date)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM party_role pr
      JOIN party_role_definition d ON d.code = pr.role
     WHERE pr.party_id = p_party AND pr.entity_id = p_entity AND d.transacts
       AND (pr.held_to IS NULL OR pr.held_to >= p_on));
$$;

CREATE OR REPLACE FUNCTION check_role_still_covers() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE orphan_date date; orphan_no text; who text;
BEGIN
  SELECT e.entry_date, e.entry_no INTO orphan_date, orphan_no
    FROM journal_line jl JOIN journal_entry e ON e.id = jl.entry_id
    JOIN ledger l ON l.id = e.ledger_id
   WHERE jl.party_id = OLD.party_id AND l.entity_id = OLD.entity_id
     AND (OLD.held_to IS NULL OR e.entry_date <= OLD.held_to)
     AND NOT party_may_transact(OLD.party_id, OLD.entity_id, e.entry_date)
   ORDER BY e.entry_date LIMIT 1;
  IF orphan_date IS NOT NULL THEN
    SELECT name INTO who FROM party WHERE id = OLD.party_id;
    RAISE EXCEPTION 'ROLE_STILL_NEEDED: % is named on % dated %, which this role is what explains; end it on or after that date',
      COALESCE(who, OLD.party_id::text), COALESCE(orphan_no, 'a draft'), orphan_date;
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION check_role_kind_still_covers() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n bigint;
BEGIN
  IF NEW.transacts OR NOT OLD.transacts THEN RETURN NULL; END IF;
  SELECT count(*) INTO n
    FROM journal_line jl JOIN journal_entry e ON e.id = jl.entry_id
    JOIN ledger l ON l.id = e.ledger_id
   WHERE jl.party_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM party_role pr
       WHERE pr.party_id = jl.party_id AND pr.entity_id = l.entity_id AND pr.role = OLD.code
         AND (pr.held_to IS NULL OR e.entry_date <= pr.held_to))
     AND NOT party_may_transact(jl.party_id, l.entity_id, e.entry_date);
  IF n > 0 THEN
    RAISE EXCEPTION 'ROLE_KIND_STILL_NEEDED: % journal line% explained by the % role; it cannot stop being one that trades',
      n, CASE WHEN n = 1 THEN ' is' ELSE 's are' END, OLD.code;
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION check_invoice_party_role() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE want text; who text; held text;
BEGIN
  want := CASE WHEN NEW.direction = 'sales' THEN 'customer' ELSE 'supplier' END;
  IF EXISTS (SELECT 1 FROM party_role pr
    WHERE pr.party_id = NEW.party_id AND pr.entity_id = NEW.entity_id AND pr.role = want
      AND (pr.held_to IS NULL OR pr.held_to >= NEW.issued_on)) THEN
    RETURN NULL;
  END IF;
  SELECT name INTO who FROM party WHERE id = NEW.party_id;
  SELECT string_agg(DISTINCT pr.role, ', ' ORDER BY pr.role) INTO held FROM party_role pr
   WHERE pr.party_id = NEW.party_id AND pr.entity_id = NEW.entity_id
     AND (pr.held_to IS NULL OR pr.held_to >= NEW.issued_on);
  RAISE EXCEPTION 'INVOICE_PARTY_ROLE: % is not a % of this company on %',
    COALESCE(who, NEW.party_id::text), want, NEW.issued_on::text
      || CASE WHEN held IS NULL THEN '' ELSE ' — they are ' || held || ' here' END;
END $$;
