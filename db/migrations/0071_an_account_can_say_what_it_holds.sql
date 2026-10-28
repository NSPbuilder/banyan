-- AN ACCOUNT CAN SAY WHAT IT HOLDS, FOR SR&ED.
--
-- The owner's plan (2026-09-10): post SR&ED costs into R&D sub-accounts as they
-- happen, one per T661 line — materials, contracts, third-party, overhead — so
-- the split is made on the day the invoice arrives rather than remembered
-- fourteen months later. That is sound bookkeeping and CRA asks nothing about
-- which account a cost sat in; it asks for amounts by category and how they
-- were arrived at.
--
-- So the system reads their chart instead of asking them to tag a second time:
-- a tagged account's lines sort to the top of the allocation table, arrive with
-- the category already chosen and 100% offered. NOTHING IS DECIDED BY THE TAG.
-- The percentage and the basis sentence are still the person's, still stored,
-- still what an auditor reads — "this account only ever holds this project's
-- costs" is a perfectly good basis, and it has to be written down like any
-- other.
--
-- `salary` is deliberately NOT one of the choices. Salary is claimed through the
-- pay stub, where the specified-employee cap can be applied, and the door
-- refuses a journal line claimed as salary (WRONG_CATEGORY) — an account tagged
-- that way would be an invitation to a refusal.
ALTER TABLE account ADD COLUMN sred_category text
  CHECK (sred_category IN ('materials', 'contract', 'third_party', 'overhead', 'capital'));
COMMENT ON COLUMN account.sred_category IS
  'Which T661 line this account''s costs feed, when its costs are SR&ED. A hint to '
  'the allocation screen, never a decision: the percent and the basis are still typed by a person.';
