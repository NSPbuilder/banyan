-- =============================================================================
-- 0014 — whether a company is registered for a sales tax, and since when.
--
-- Not every company is. In Canada a business under the small-supplier threshold
-- need not register for GST/HST at all, and until now every company got a
-- GST/HST return whether or not it had anything to do with one. A return of all
-- zeroes reads as "no tax this quarter"; the truth might be "this company is
-- not registered". Those need different answers.
--
-- Registration is a FACT WITH A DATE, not a switch. A company registers
-- effective a day, and sales before that day carry no tax. A boolean cannot say
-- that, and the return works on date ranges — so the two would disagree with
-- nothing to notice.
-- =============================================================================

CREATE TABLE entity_tax_registration (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id      uuid NOT NULL REFERENCES entity(id),

  -- GST_HST covers both: they are one tax administered together, and a company
  -- has one number for it whichever province it is in.
  tax            text NOT NULL CHECK (tax IN ('GST_HST', 'QST', 'PST')),

  -- The number that goes on an invoice and on the return.
  number         text NOT NULL CHECK (length(trim(number)) > 0),

  registered_on  date NOT NULL,
  ceased_on      date,

  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     text NOT NULL DEFAULT 'system',

  CHECK (ceased_on IS NULL OR ceased_on >= registered_on)
);

CREATE INDEX entity_tax_registration_lookup
  ON entity_tax_registration (entity_id, tax, registered_on);

-- A company cannot be registered for the same tax twice over the same days.
-- Deregistering and registering again later is ordinary; overlapping is not.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE entity_tax_registration ADD CONSTRAINT entity_tax_registration_no_overlap
  EXCLUDE USING gist (
    entity_id WITH =,
    tax WITH =,
    daterange(registered_on, COALESCE(ceased_on, 'infinity'::date), '[]') WITH &&
  );

-- Registering and deregistering are both worth a record: they decide whether a
-- sale should have carried tax.
CREATE OR REPLACE FUNCTION log_tax_registration() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO audit_log (actor, action, table_name, record_id, after, context)
    VALUES (NEW.created_by, 'register_tax', 'entity_tax_registration', NEW.id::text,
            jsonb_build_object('tax', NEW.tax, 'number', NEW.number,
                               'registered_on', NEW.registered_on),
            jsonb_build_object('entity_id', NEW.entity_id));
    RETURN NEW;
  END IF;

  IF NEW.ceased_on IS DISTINCT FROM OLD.ceased_on THEN
    INSERT INTO audit_log (actor, action, table_name, record_id, before, after, context)
    VALUES (current_user,
            CASE WHEN NEW.ceased_on IS NULL THEN 'resume_tax_registration' ELSE 'cease_tax_registration' END,
            'entity_tax_registration', NEW.id::text,
            jsonb_build_object('ceased_on', OLD.ceased_on),
            jsonb_build_object('ceased_on', NEW.ceased_on),
            jsonb_build_object('tax', NEW.tax, 'entity_id', NEW.entity_id));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_tax_registration_audit
  AFTER INSERT OR UPDATE ON entity_tax_registration
  FOR EACH ROW EXECUTE FUNCTION log_tax_registration();

-- Report tax posted outside the days a company was registered. Sales tax
-- charged before registering, or after ceasing, is a real problem with a real
-- deadline — and nothing else in the system would notice.
CREATE OR REPLACE FUNCTION check_tax_outside_registration(p_ledger_id uuid)
RETURNS TABLE (entry_no text, entry_date date, description text, tax text, amount bigint) AS $$
  SELECT je.entry_no, je.entry_date, je.description,
         CASE WHEN ar.role LIKE 'gst%' THEN 'GST_HST' ELSE 'QST/PST' END,
         SUM(jl.amount)::bigint
    FROM journal_entry je
    JOIN journal_line jl ON jl.entry_id = je.id
    JOIN account a ON a.id = jl.account_id
    JOIN account_role ar ON ar.account_id = a.id
    JOIN ledger l ON l.id = je.ledger_id
   WHERE je.ledger_id = p_ledger_id
     AND je.status IN ('posted','reversed')
     AND ar.role IN ('gst_hst_payable', 'gst_hst_recoverable',
                     'qst_pst_payable', 'qst_pst_recoverable')
     AND NOT EXISTS (
       SELECT 1 FROM entity_tax_registration r
        WHERE r.entity_id = l.entity_id
          AND r.tax = CASE WHEN ar.role LIKE 'gst%' THEN 'GST_HST'
                           WHEN ar.role LIKE 'qst%' THEN 'QST' ELSE 'PST' END
          AND je.entry_date >= r.registered_on
          AND (r.ceased_on IS NULL OR je.entry_date <= r.ceased_on))
   GROUP BY je.entry_no, je.entry_date, je.description, ar.role
  HAVING SUM(jl.amount) <> 0
   ORDER BY je.entry_date;
$$ LANGUAGE sql STABLE;
