-- 0045 — the party refusal names the rule it enforces, not 0025's vocabulary
--
-- Why: 0044 made every seeded role transact, and the two guards from 0026
-- still refused with "is not a customer, supplier or employee of this
-- company" — a sentence about a vocabulary that no longer exists. The rule
-- they enforce did not change: a line may only name a party holding a
-- transacting role at that company covering the entry date. The sentence now
-- says that. Bodies are otherwise copied from 0026 verbatim (append-only:
-- corrections land in new files, as 0027 did for 0026).
--
-- A correction to 0044's own header while here: it stamps the shareholder
-- flip "owner decision 2026-09-02". The owner's verbatim ask named DIRECTORS
-- (a director advancing money); shareholder was flipped with it as the same
-- class — dividends and shareholder loans are money moving against a person
-- in that capacity. That extension is the assistant's call, surfaced to the
-- owner, and reversible until the first shareholder-explained line posts
-- (0027's guard then holds it, deliberately).

CREATE OR REPLACE FUNCTION check_line_party() RETURNS trigger AS $$
DECLARE
  line_entity uuid;
  line_date   date;
  party_name  text;
BEGIN
  IF NEW.party_id IS NULL THEN RETURN NEW; END IF;

  SELECT l.entity_id, e.entry_date INTO line_entity, line_date
    FROM journal_entry e JOIN ledger l ON l.id = e.ledger_id
   WHERE e.id = NEW.entry_id;

  IF NOT party_may_transact(NEW.party_id, line_entity, line_date) THEN
    SELECT name INTO party_name FROM party WHERE id = NEW.party_id;
    RAISE EXCEPTION 'PARTY_NOT_TRADING: % holds no transacting role at this company covering %',
      COALESCE(party_name, NEW.party_id::text), line_date;
  END IF;

  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION recheck_lines_on_date_change() RETURNS trigger AS $$
DECLARE
  bad_party uuid;
  who       text;
BEGIN
  IF NEW.entry_date IS NOT DISTINCT FROM OLD.entry_date THEN RETURN NULL; END IF;

  SELECT jl.party_id INTO bad_party
    FROM journal_line jl
    JOIN ledger l ON l.id = NEW.ledger_id
   WHERE jl.entry_id = NEW.id
     AND jl.party_id IS NOT NULL
     AND NOT party_may_transact(jl.party_id, l.entity_id, NEW.entry_date)
   LIMIT 1;

  IF bad_party IS NOT NULL THEN
    SELECT name INTO who FROM party WHERE id = bad_party;
    RAISE EXCEPTION 'PARTY_NOT_TRADING: % holds no transacting role at this company covering %',
      COALESCE(who, bad_party::text), NEW.entry_date;
  END IF;

  RETURN NULL;
END $$ LANGUAGE plpgsql;
