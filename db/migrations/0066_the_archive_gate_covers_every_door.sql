-- 0066 — 0065's gate covered two tables; it needs to cover every door in.
--
-- 0065 said 「再也进不了任何东西」 and put BEFORE INSERT triggers on
-- `journal_entry` and `fiscal_year`. That is the POSTING door and one other,
-- and this system has more: an invoice is a document that exists before it
-- posts, a pay run likewise, a bank file lands as rows against an account
-- before anything is matched to it, and a bill read by the assistant is kept
-- before anybody decides what it is. Every one of those could be created in
-- an archived company, and the refusal — when it came at all — came at Post,
-- leaving the document behind (critic, 2026-09-07).
--
-- Two shapes, because these tables reach a company two ways:
--
--   through a LEDGER   invoice, pay_run, ai_bill_reading  (0065's function)
--   through an ACCOUNT bank_transaction, bank_statement
--
-- `account` and the corporate-records tables are deliberately NOT gated: a
-- chart of accounts and a minute book are the company's own description
-- rather than something entering its books, and an archived company whose
-- registered office moved should still be able to say so.
--
-- TWO CORRECTIONS TO 0065's OWN HEADER, which is checksummed and cannot be
-- edited (the same reason 0056 carries 0055's):
--
--   * it says a dozen queries filter `entity.is_active`. ONE does —
--     `allCompanies` in access.ts, the list the grants screen offers. Nothing
--     writes the column. The count was wrong; the argument for the generated
--     column is not.
--   * making that one query mean "not archived" broke it: the grants screen
--     sends back every tick, so an archived company missing from the ticks
--     had its grants deleted on the next save by anybody. `allCompanies` now
--     returns archived companies too, flagged (`CO9`).

CREATE TRIGGER trg_invoice_entity_archived
  BEFORE INSERT ON invoice
  FOR EACH ROW EXECUTE FUNCTION check_entity_archived();

CREATE TRIGGER trg_pay_run_entity_archived
  BEFORE INSERT ON pay_run
  FOR EACH ROW EXECUTE FUNCTION check_entity_archived();

CREATE TRIGGER trg_bill_reading_entity_archived
  BEFORE INSERT ON ai_bill_reading
  FOR EACH ROW EXECUTE FUNCTION check_entity_archived();

-- The account-shaped half. Same sentence, so a person meets one refusal
-- whichever door they were at.
CREATE OR REPLACE FUNCTION check_account_entity_archived() RETURNS trigger AS $$
DECLARE
  archived timestamptz;
  who text;
BEGIN
  SELECT e.archived_at, e.name INTO archived, who
    FROM account a JOIN entity e ON e.id = a.entity_id
   WHERE a.id = NEW.account_id;
  IF archived IS NOT NULL THEN
    RAISE EXCEPTION 'ENTITY_ARCHIVED: % was archived on %; bring it back before putting anything in it',
      who, archived::date;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_bank_row_entity_archived
  BEFORE INSERT ON bank_transaction
  FOR EACH ROW EXECUTE FUNCTION check_account_entity_archived();

CREATE TRIGGER trg_bank_statement_entity_archived
  BEFORE INSERT ON bank_statement
  FOR EACH ROW EXECUTE FUNCTION check_account_entity_archived();
