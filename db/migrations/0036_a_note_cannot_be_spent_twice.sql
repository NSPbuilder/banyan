-- 0036 — a note cannot be spent twice
--
-- 0034's trigger kept two separate caps: what is applied ON an invoice, and
-- what is applied BY an entry. A review met them in the middle: a credit note
-- is a document AND a source of settlement, and nothing summed its two
-- consumptions. Two committed rows — a refund applied TO the note, the note's
-- entry applied to an invoice — left the note's derived balance at −15,000
-- while every row looked right on its own. The trigger was enforcing a weaker
-- invariant than the balance derivation (`OPEN_ITEMS` subtracts BOTH sums),
-- which is this repository's two-spellings defect with money on it.
--
-- The same review found the capacity read GROSS: an entry carrying +N and −N
-- for one party nets zero movement and still held capacity N.
--
-- So the rule is now the derivation's rule, stated once:
--
--   for ANY invoice document touched by an application — as target, or as the
--   document whose entry is doing the settling —
--       applications ON it + applications BY its entry  ≤  |its movement|
--
-- and an entry's capacity toward settling is its NET movement on that account
-- for that party, in the settling direction.
CREATE OR REPLACE FUNCTION check_application_valid() RETURNS trigger AS $$
DECLARE
  inv        record;
  src_doc    record;
  ent_status text;
  ent_ledger uuid;
  inv_mov    bigint;
  settle_net bigint;
  ent_applied bigint;
  consumed   bigint;
  src_mov    bigint;
  src_consumed bigint;
BEGIN
  SELECT i.id, i.status, i.ledger_id, i.party_id, i.control_account_id,
         i.entry_id, i.number
    INTO inv
    FROM invoice i WHERE i.id = NEW.invoice_id;

  IF inv.status <> 'posted' THEN
    RAISE EXCEPTION 'APPLICATION_INVOICE_NOT_POSTED: % is %, and only a posted invoice is a debt',
      COALESCE(inv.number, 'that invoice'), inv.status;
  END IF;

  SELECT je.status, je.ledger_id INTO ent_status, ent_ledger
    FROM journal_entry je WHERE je.id = NEW.entry_id;

  IF ent_status <> 'posted' THEN
    RAISE EXCEPTION 'APPLICATION_ENTRY_NOT_POSTED: that entry is %, not posted', ent_status;
  END IF;

  IF ent_ledger IS DISTINCT FROM inv.ledger_id THEN
    RAISE EXCEPTION 'APPLICATION_LEDGER: that entry is in another set of books';
  END IF;

  -- The debt, read from the ledger.
  SELECT COALESCE(SUM(jl.amount), 0) INTO inv_mov
    FROM journal_line jl
   WHERE jl.entry_id = inv.entry_id
     AND jl.account_id = inv.control_account_id
     AND jl.party_id = inv.party_id;

  IF inv_mov = 0 THEN
    RAISE EXCEPTION 'APPLICATION_NO_DEBT: the entry behind % holds nothing on its control account',
      COALESCE(inv.number, 'that invoice');
  END IF;

  -- The settling entry's NET movement for this account and party. Net, not the
  -- gross of one sign: an entry that puts +N and −N on the same party has
  -- moved nothing and settles nothing.
  SELECT COALESCE(SUM(jl.amount), 0) INTO settle_net
    FROM journal_line jl
   WHERE jl.entry_id = NEW.entry_id
     AND jl.account_id = inv.control_account_id
     AND jl.party_id = inv.party_id;

  IF settle_net = 0 OR sign(settle_net) <> -sign(inv_mov) THEN
    RAISE EXCEPTION 'APPLICATION_WRONG_WAY: that entry does not move %''s control account toward settling it',
      COALESCE(inv.number, 'that invoice');
  END IF;

  -- The entry cannot promise more than its net movement, across every invoice
  -- it settles for this account and party.
  SELECT COALESCE(SUM(a.amount), 0) INTO ent_applied
    FROM invoice_application a
    JOIN invoice i2 ON i2.id = a.invoice_id
   WHERE a.entry_id = NEW.entry_id
     AND i2.control_account_id = inv.control_account_id
     AND i2.party_id = inv.party_id;

  IF ent_applied > abs(settle_net) THEN
    RAISE EXCEPTION 'APPLICATION_OVER_ENTRY: that entry holds % toward this party and % is already applied',
      abs(settle_net), ent_applied;
  END IF;

  -- The TARGET document's whole consumption: applications on it, plus
  -- applications its own entry has made elsewhere. The same identity the
  -- balance derivation uses — one rule, not two spellings.
  SELECT COALESCE((SELECT SUM(a.amount) FROM invoice_application a
                    WHERE a.invoice_id = inv.id), 0)
       + COALESCE((SELECT SUM(a.amount) FROM invoice_application a
                    WHERE a.entry_id = inv.entry_id), 0)
    INTO consumed;

  IF consumed > abs(inv_mov) THEN
    RAISE EXCEPTION 'APPLICATION_OVER_INVOICE: % consumed of a % document, %',
      consumed, abs(inv_mov), COALESCE(inv.number, 'that invoice');
  END IF;

  -- And if the SETTLING entry is itself a document's entry (a credit note
  -- settling an invoice), that document's whole consumption too. This is the
  -- meeting point 0034 did not have: without it, a note could be paid down as
  -- a target and spent as a source, each side under its own cap, the two
  -- together at twice its value.
  SELECT i.id, i.number, i.entry_id, i.control_account_id, i.party_id
    INTO src_doc
    FROM invoice i WHERE i.entry_id = NEW.entry_id;

  IF src_doc.id IS NOT NULL THEN
    SELECT COALESCE(SUM(jl.amount), 0) INTO src_mov
      FROM journal_line jl
     WHERE jl.entry_id = src_doc.entry_id
       AND jl.account_id = src_doc.control_account_id
       AND jl.party_id = src_doc.party_id;

    SELECT COALESCE((SELECT SUM(a.amount) FROM invoice_application a
                      WHERE a.invoice_id = src_doc.id), 0)
         + COALESCE((SELECT SUM(a.amount) FROM invoice_application a
                      WHERE a.entry_id = src_doc.entry_id), 0)
      INTO src_consumed;

    IF src_consumed > abs(src_mov) THEN
      RAISE EXCEPTION 'APPLICATION_OVER_DOCUMENT: that entry belongs to %, which would be consumed % of a % value',
        COALESCE(src_doc.number, 'a document'), src_consumed, abs(src_mov);
    END IF;
  END IF;

  RETURN NULL;
END $$ LANGUAGE plpgsql;

-- -----------------------------------------------------------------------------
-- The audit payload's exclusion list becomes the visibility table's answer.
--
-- 0035 stripped three fields by name while `register_field_visibility` marked
-- eight private — two hand-kept spellings of "which fields are private", and
-- the audit rows were carrying `how_control`, `citizen_or_pr`,
-- `tax_resident_ca` and `became_on` into a log nothing filters. One list now:
-- the trigger reads the private fields from the table that IS the answer.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION log_corporate_record_change() RETURNS trigger AS $$
DECLARE
  payload jsonb;
  f record;
BEGIN
  payload := to_jsonb(NEW);
  FOR f IN SELECT DISTINCT field FROM register_field_visibility WHERE visibility = 'private'
  LOOP
    payload := payload - f.field;
  END LOOP;

  INSERT INTO audit_log (actor, action, table_name, record_id, after)
  VALUES (COALESCE(NEW.created_by, 'system'),
          'record_' || TG_TABLE_NAME, TG_TABLE_NAME, NEW.id::text, payload);
  RETURN NEW;
END $$ LANGUAGE plpgsql;
