-- The journal names its door.
--
-- Quick expense and quick income were posting as 'manual', which made them
-- indistinguishable from a hand-typed journal in every list and every audit
-- row. They become source types of their own, and the application keys entry
-- numbering off the source: JE for manual, INV/BILL for the invoice doors,
-- PAY, EXP, INC, BNK, OPN, CLS, ADJ — one continuous sequence per source with
-- no year in the number, because the entry's date already says the year and a
-- per-year restart would mint the same number twice once the year is dropped.
-- Numbers already issued are on posted entries and posted entries are
-- immutable, so nothing is renumbered.

ALTER TABLE journal_entry DROP CONSTRAINT journal_entry_source_type_check;
ALTER TABLE journal_entry ADD CONSTRAINT journal_entry_source_type_check
  CHECK (source_type IN ('manual','opening_balance','ar_invoice','ap_bill',
                         'payment','bank','period_close','adjustment',
                         'quick_expense','quick_income'));
