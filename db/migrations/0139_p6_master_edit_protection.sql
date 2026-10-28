ALTER TABLE account ADD COLUMN version bigint NOT NULL DEFAULT 1 CHECK(version>0);
ALTER TABLE party ADD COLUMN version bigint NOT NULL DEFAULT 1 CHECK(version>0);
CREATE TRIGGER p6_account_version BEFORE UPDATE ON account FOR EACH ROW EXECUTE FUNCTION p1_bump_version();
CREATE TRIGGER p6_party_version BEFORE UPDATE ON party FOR EACH ROW EXECUTE FUNCTION p1_bump_version();
CREATE FUNCTION p6_master_child_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r jsonb; old_id uuid; new_id uuid; target uuid;
BEGIN
  IF TG_OP<>'INSERT' THEN
    r := to_jsonb(OLD);old_id := coalesce((r->>'party_id')::uuid,(r->>'account_id')::uuid);
  END IF;
  IF TG_OP<>'DELETE' THEN
    r := to_jsonb(NEW);new_id := coalesce((r->>'party_id')::uuid,(r->>'account_id')::uuid);
  END IF;
  FOR target IN SELECT DISTINCT unnest(ARRAY[old_id,new_id]) ORDER BY 1 LOOP
    IF TG_TABLE_NAME='account_role' THEN UPDATE account SET version=version WHERE id=target;
    ELSE UPDATE party SET version=version WHERE id=target; END IF;
  END LOOP;
  RETURN COALESCE(NEW,OLD);
END $$;
CREATE TRIGGER p6_account_role_version BEFORE INSERT OR UPDATE OR DELETE ON account_role FOR EACH ROW EXECUTE FUNCTION p6_master_child_version();
CREATE TRIGGER p6_party_role_version BEFORE INSERT OR UPDATE OR DELETE ON party_role FOR EACH ROW EXECUTE FUNCTION p6_master_child_version();
CREATE TRIGGER p6_party_address_version BEFORE INSERT OR UPDATE OR DELETE ON party_address FOR EACH ROW EXECUTE FUNCTION p6_master_child_version();
CREATE TRIGGER p6_party_contact_version BEFORE INSERT OR UPDATE OR DELETE ON party_contact FOR EACH ROW EXECUTE FUNCTION p6_master_child_version();
ALTER TABLE document_edit_lease ADD COLUMN account_id uuid UNIQUE REFERENCES account(id) ON DELETE CASCADE,
  ADD COLUMN party_id uuid UNIQUE REFERENCES party(id) ON DELETE CASCADE;
-- Extend the existing exactly-one-resource constraint in the same transaction.
ALTER TABLE document_edit_lease DROP CONSTRAINT document_edit_lease_one_resource;
ALTER TABLE document_edit_lease ADD CONSTRAINT document_edit_lease_one_resource CHECK
  (num_nonnulls(invoice_id,journal_entry_id,inbox_item_id,recurring_template_id,reminder_rule_id,migration_run_id,budget_id,payment_connection_id,inbound_connection_id,account_id,party_id)=1);
CREATE OR REPLACE FUNCTION p1_lease_scope() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.invoice_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM invoice WHERE id=NEW.invoice_id AND ledger_id=NEW.ledger_id)
  OR NEW.journal_entry_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM journal_entry WHERE id=NEW.journal_entry_id AND ledger_id=NEW.ledger_id)
  OR NEW.inbox_item_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM inbox_item WHERE id=NEW.inbox_item_id AND ledger_id=NEW.ledger_id)
  OR NEW.recurring_template_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM recurring_template WHERE id=NEW.recurring_template_id AND ledger_id=NEW.ledger_id)
  OR NEW.reminder_rule_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM reminder_rule WHERE id=NEW.reminder_rule_id AND ledger_id=NEW.ledger_id)
  OR NEW.migration_run_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM migration_run WHERE id=NEW.migration_run_id AND ledger_id=NEW.ledger_id)
  OR NEW.budget_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM budget WHERE id=NEW.budget_id AND ledger_id=NEW.ledger_id)
  OR NEW.payment_connection_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM payment_connection WHERE id=NEW.payment_connection_id AND ledger_id=NEW.ledger_id)
  OR NEW.inbound_connection_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM inbound_connection WHERE id=NEW.inbound_connection_id AND ledger_id=NEW.ledger_id)
  OR NEW.account_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM account a JOIN ledger l ON l.entity_id=a.entity_id WHERE a.id=NEW.account_id AND l.id=NEW.ledger_id)
  OR NEW.party_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM party_role pr JOIN ledger l ON l.entity_id=pr.entity_id WHERE pr.party_id=NEW.party_id AND l.id=NEW.ledger_id)
  THEN RAISE EXCEPTION 'EDIT_LEASE_SCOPE'; END IF;
  IF NOT EXISTS(SELECT 1 FROM user_session WHERE token_hash=NEW.session_hash AND user_id=NEW.holder_user_id) THEN RAISE EXCEPTION 'EDIT_LEASE_SESSION'; END IF;
  RETURN NEW;
END $$;
