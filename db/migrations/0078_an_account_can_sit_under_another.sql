-- AN ACCOUNT CAN SIT UNDER ANOTHER — the column finally gets a door.
--
-- `account.parent_id` has been in the schema since 0001, and 0008 has audited
-- every change to it since. Nothing could set it except a pasted chart, nothing
-- could change it afterwards at all, and no screen drew it: `chartOfAccounts`
-- selected the parent's code and the chart screen declared the field and never
-- read it. The owner found it by looking for it (2026-09-15: 「COA没有
-- subaccount功能」) — which is exactly right, because a column is not a feature.
--
-- The scope is the owner's, named rather than assumed: SUB-ACCOUNTS GROUP THE
-- CHART, THEY DO NOT MOVE MONEY. Statements still reference roles and only
-- roles — 0001 says so and nothing here changes it — so a parent carries no
-- total, and moving an account under another one cannot alter a figure on any
-- report. That is the property this migration has to keep true, and it keeps it
-- by making the tree too well-formed to mean anything else.
--
-- Four rules, all here rather than only in the application, because the pasted
-- chart, the form, a restore and psql are four doors onto the same column:
--
--   1. A parent belongs to the same company. Otherwise one company's chart
--      would name a row in another's, which is the shape 0008 already refuses
--      for entity_id itself.
--   2. A parent is the same ACCOUNT TYPE. An expense filed under an asset would
--      read as a total on the chart that no statement would ever produce — the
--      chart would say one thing and the balance sheet another, and the person
--      reading them would have no way to tell which was lying.
--   3. No cycles. A cycle makes the chart unprintable and any walk of it
--      endless; it also cannot be undone through a screen, because every screen
--      renders the chart first.
--   4. At most five levels. The cap falls out of the cycle walk for free, and
--      it is what keeps an indented chart on the page. It also bounds the walk
--      itself, so a cycle that somehow predates this trigger is refused rather
--      than spun on.
--
-- And one rule about the other end: an account with sub-accounts cannot change
-- its own type, because rule 2 is checked on the row being written and the
-- children are not being written. Without this, re-typing a parent would leave
-- a tree that no INSERT could have built.

CREATE OR REPLACE FUNCTION guard_account_parent() RETURNS trigger AS $$
DECLARE
  p       RECORD;
  v_at    uuid;
  v_depth int := 0;
  v_kid   text;
BEGIN
  -- The other end first: re-typing a parent would break rule 2 from above,
  -- where no per-row check can see it.
  IF TG_OP = 'UPDATE' AND NEW.account_type IS DISTINCT FROM OLD.account_type THEN
    SELECT code INTO v_kid FROM account WHERE parent_id = NEW.id ORDER BY code LIMIT 1;
    IF v_kid IS NOT NULL THEN
      RAISE EXCEPTION
        'Account % has sub-accounts (% is one); its type cannot change while they sit under it. Move them out first.',
        NEW.code, v_kid;
    END IF;
  END IF;

  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.parent_id = NEW.id THEN
    RAISE EXCEPTION 'Account % cannot sit under itself.', NEW.code;
  END IF;

  SELECT id, entity_id, code, name, account_type INTO p
    FROM account WHERE id = NEW.parent_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Account % names a parent account that does not exist.', NEW.code;
  END IF;

  IF p.entity_id IS DISTINCT FROM NEW.entity_id THEN
    RAISE EXCEPTION 'Account % cannot sit under % %, which belongs to another company.',
      NEW.code, p.code, p.name;
  END IF;

  IF p.account_type IS DISTINCT FROM NEW.account_type THEN
    RAISE EXCEPTION
      'Account % is %(s) and % % is %(s). A sub-account is the same kind of thing as the account it sits under.',
      NEW.code, NEW.account_type, p.code, p.name, p.account_type;
  END IF;

  -- Walk up from the proposed parent. Reaching this row means the parent is
  -- one of its own descendants; running past the cap means the chain is too
  -- deep, or is a cycle that predates this trigger.
  v_at := p.id;
  WHILE v_at IS NOT NULL LOOP
    IF v_at = NEW.id THEN
      RAISE EXCEPTION 'Account % cannot sit under % %: that account is already one of its own sub-accounts.',
        NEW.code, p.code, p.name;
    END IF;
    v_depth := v_depth + 1;
    IF v_depth > 4 THEN
      RAISE EXCEPTION 'Account % would sit more than five levels deep under % %. A chart that deep cannot be read.',
        NEW.code, p.code, p.name;
    END IF;
    SELECT parent_id INTO v_at FROM account WHERE id = v_at;
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_account_parent
  BEFORE INSERT OR UPDATE ON account
  FOR EACH ROW EXECUTE FUNCTION guard_account_parent();

COMMENT ON COLUMN account.parent_id IS
  'The account this one sits under on the chart. Grouping only: statements read '
  'roles, never the tree, so a parent carries no total and moving an account '
  'changes no figure. Same company, same account_type, no cycles, five levels deep '
  'at most — all four enforced by trg_account_parent (0078).';
