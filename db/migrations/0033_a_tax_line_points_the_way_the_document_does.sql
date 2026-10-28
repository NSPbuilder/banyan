-- 0033 — a tax line points the way the rest of the document does
--
-- Why: docs/design/09-invoices.md, 「唯一会悄悄错的是哪一侧」 and the correction
-- under it.
--
-- 0031 said it guarded "which side" the tax goes. It guards which ACCOUNT the
-- tax line names — a sale may not name a recoverable account — and says nothing
-- about the line's sign. Adversarial review found the gap that leaves:
--
--   a sales invoice with lines [revenue -100000, GST payable +5000]
--
-- Every existing rule is satisfied. The account is the right one for a sale.
-- The control movement is +95000, which is the way a sales invoice must move,
-- so `movesTheRightWay` accepts it. It posts. And it DEBITS GST/HST payable, so
-- `gstHstReturn` moves line 105 by minus five thousand — tax remitted rather
-- than collected, in the very box 0031's comment is about.
--
-- The rule that closes it is simpler than the one 0031 wrote, and covers it:
-- a tax line points the same way every other line on that document points. A
-- sales invoice credits revenue and credits the tax it collected; a purchase
-- bill debits the expense and debits the tax it can reclaim. The control
-- account is the only line that goes the other way, and it is not an
-- `invoice_line` at all.
--
-- Which way "the same way" is depends on both axes, so it is the same predicate
-- as everywhere else: `(direction = 'sales') = (document_kind = 'invoice')`
-- means the control account is debited, and therefore the LINES are credits.

CREATE OR REPLACE FUNCTION check_invoice_tax_side() RETURNS trigger AS $$
DECLARE
  inv            invoice%ROWTYPE;
  bad_code       text;
  bad_name       text;
  bad_role       text;
  wrong_account  text;
  lines_are_credits boolean;
BEGIN
  SELECT * INTO inv FROM invoice WHERE id = NEW.invoice_id;
  IF inv.id IS NULL THEN RETURN NULL; END IF;

  -- 1. The account, as 0031 had it. A sale may not name a recoverable account.
  wrong_account := CASE WHEN inv.direction = 'sales' THEN '_recoverable' ELSE '_payable' END;

  SELECT a.code, a.name, ar.role INTO bad_code, bad_name, bad_role
    FROM account a
    JOIN account_role ar ON ar.account_id = a.id
   WHERE a.id = NEW.account_id
     AND ar.role LIKE '%' || wrong_account
     AND (ar.role LIKE 'gst%' OR ar.role LIKE 'qst%')
   LIMIT 1;

  IF bad_code IS NOT NULL THEN
    RAISE EXCEPTION 'TAX_WRONG_SIDE: % % is %, which is the other side of the return; a % invoice collects tax rather than reclaiming it',
      bad_code, bad_name, replace(bad_role, '_', ' '), inv.direction;
  END IF;

  -- 2. And the sign, which 0031 did not ask about at all.
  lines_are_credits := (inv.direction = 'sales') = (inv.document_kind = 'invoice');

  SELECT a.code, a.name, ar.role INTO bad_code, bad_name, bad_role
    FROM account a
    JOIN account_role ar ON ar.account_id = a.id
   WHERE a.id = NEW.account_id
     AND (ar.role LIKE 'gst%' OR ar.role LIKE 'qst%')
     AND (ar.role LIKE '%_payable' OR ar.role LIKE '%_recoverable')
   LIMIT 1;

  IF bad_code IS NOT NULL
     AND ((lines_are_credits AND NEW.amount > 0) OR (NOT lines_are_credits AND NEW.amount < 0))
  THEN
    RAISE EXCEPTION 'TAX_WRONG_WAY: the tax on % % goes the opposite way to the rest of this %; a % % %s its tax line',
      bad_code, bad_name,
      CASE WHEN inv.document_kind = 'invoice' THEN 'invoice' ELSE 'credit note' END,
      inv.direction,
      CASE WHEN inv.document_kind = 'invoice' THEN 'invoice' ELSE 'credit note' END,
      CASE WHEN lines_are_credits THEN 'credit' ELSE 'debit' END;
  END IF;

  RETURN NULL;
END $$ LANGUAGE plpgsql;

-- -----------------------------------------------------------------------------
-- And two columns the freeze had left out.
--
-- `forbid_posted_invoice_change` names its frozen columns one by one, which is
-- deliberate — a whole-row comparison would also freeze `posted_at`, which the
-- posting itself writes. The cost of a list is that it is a list: six of
-- `invoice`'s columns were outside it, and two of those are actor attribution
-- on a document the system otherwise treats as unchangeable.
--
-- `created_by` and `posted_by` say who did it. On a document that cannot
-- otherwise be edited, being able to rewrite who issued it is the one change
-- that leaves no trace anywhere — the audit row records the status change, not
-- a later edit of the name attached to it.
--
-- Still deliberately unfrozen: `id` (the primary key), `note` (a comment, not a
-- figure, and worth being able to add later), `created_at` and `posted_at`
-- (written by the system, and `posted_at` is written BY the posting this guard
-- runs during).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION forbid_posted_invoice_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'INVOICE_NOT_DRAFT: % has been posted; void it rather than deleting it',
        COALESCE(OLD.number, 'that invoice');
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT ((OLD.status = 'draft'  AND NEW.status = 'posted')
           OR (OLD.status = 'draft'  AND NEW.status = 'void')
           OR (OLD.status = 'posted' AND NEW.status = 'void')) THEN
    RAISE EXCEPTION 'INVOICE_TRANSITION: % cannot go from % to %; issue another instead',
      COALESCE(NEW.number, 'that invoice'), OLD.status, NEW.status;
  END IF;

  IF OLD.status <> 'draft' THEN
    IF NEW.party_id IS DISTINCT FROM OLD.party_id
       OR NEW.issued_on IS DISTINCT FROM OLD.issued_on
       OR NEW.due_on IS DISTINCT FROM OLD.due_on
       OR NEW.control_account_id IS DISTINCT FROM OLD.control_account_id
       OR NEW.direction IS DISTINCT FROM OLD.direction
       OR NEW.document_kind IS DISTINCT FROM OLD.document_kind
       OR NEW.ledger_id IS DISTINCT FROM OLD.ledger_id
       OR NEW.entity_id IS DISTINCT FROM OLD.entity_id
       OR NEW.number IS DISTINCT FROM OLD.number
       OR NEW.their_ref IS DISTINCT FROM OLD.their_ref
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
       -- `posted_by` is written by the posting itself, so it may go from NULL
       -- to a name once. What it may not do is change afterwards.
       OR (NEW.posted_by IS DISTINCT FROM OLD.posted_by AND OLD.posted_by IS NOT NULL)
       OR (NEW.entry_id IS DISTINCT FROM OLD.entry_id
           AND NOT (NEW.status = 'void' AND NEW.entry_id IS NULL)) THEN
      RAISE EXCEPTION 'INVOICE_POSTED: % is % and cannot be changed; void it and issue another',
        COALESCE(NEW.number, 'that invoice'), OLD.status;
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
