-- An account's SR&ED tag belongs to SR&ED.
--
-- 0071 put sred_category on account, so the framework's chart of accounts
-- carried an SR&ED field and its forms offered it (docs/design/48-module-boundaries.md).
-- The tag moves to a table SR&ED owns, tagged from the SR&ED screen. The old
-- column stays — migrations only add, and an older build still reads it — but
-- from this version on nothing reads or writes it; its values are copied here
-- once.
CREATE TABLE sred_account_category (
  account_id uuid PRIMARY KEY REFERENCES account(id) ON DELETE CASCADE,
  category   text NOT NULL
    CHECK (category IN ('materials', 'contract', 'third_party', 'overhead', 'capital')),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by text NOT NULL
);

INSERT INTO sred_account_category (account_id, category, updated_by)
SELECT id, sred_category, 'migration 0156' FROM account WHERE sred_category IS NOT NULL;

COMMENT ON COLUMN account.sred_category IS
  'Frozen by 0156: the tag lives in sred_account_category. Kept for older builds only.';
