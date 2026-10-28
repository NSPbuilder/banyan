-- 0088 · The Assistant learns which door a request belongs to.
--
-- The first model turn is now a router.  It sees only skills the person may
-- use in this company and either asks one clarification or selects exactly
-- one.  The exact module system prompt is written here BEFORE the first
-- request to that module leaves, preserving 0076's reconstructable trail.

ALTER TABLE ai_inquiry_step DROP CONSTRAINT ai_inquiry_step_outcome_check;
ALTER TABLE ai_inquiry_step ADD CONSTRAINT ai_inquiry_step_outcome_check CHECK (outcome IN (
  'route', 'clarify',
  'call', 'unreadable', 'too_much', 'answer', 'answer_unformatted',
  'refusal', 'error', 'cut_off', 'call_after_limit', 'too_slow', 'more'
));

CREATE TABLE ai_inquiry_skill (
  inquiry_id    uuid PRIMARY KEY REFERENCES ai_inquiry(id),
  routed_at     timestamptz NOT NULL DEFAULT now(),
  skill         text NOT NULL CHECK (skill IN (
                  'books', 'crm', 'transactions', 'invoices', 'banking', 'journal', 'parties', 'accounts',
                  'reports', 'tax', 'payroll', 'records', 'periods', 'opening', 'sred', 'backup')),
  route_reason  text NOT NULL CHECK (length(btrim(route_reason)) > 0),
  request       text NOT NULL CHECK (length(btrim(request)) > 0),
  -- Verbatim module prompt, including the tools filtered by this person's
  -- seats when routing happened.  It is never regenerated for old history.
  system        text NOT NULL CHECK (length(system) > 0)
);

-- A confirmed AI command is a fact, not mutable workflow state.  Its source
-- is the immutable inquiry step; inserting this row happens in the SAME CRM
-- transaction as the business row and its audit event.  A retry therefore
-- either sees this primary key or the first attempt rolled back completely.
CREATE TABLE ai_skill_command_execution (
  inquiry_id    uuid NOT NULL,
  step_n        integer NOT NULL,
  entity_id     uuid NOT NULL REFERENCES entity(id),
  executed_at   timestamptz NOT NULL DEFAULT now(),
  executed_by   text NOT NULL,
  tool          text NOT NULL CHECK (tool LIKE 'crm_draft_%'),
  PRIMARY KEY (inquiry_id, step_n),
  FOREIGN KEY (inquiry_id, step_n) REFERENCES ai_inquiry_step(inquiry_id, n)
);
CREATE INDEX ai_skill_command_execution_entity_idx
  ON ai_skill_command_execution (entity_id, executed_at DESC);

CREATE TRIGGER trg_ai_inquiry_skill_immutable
  BEFORE UPDATE OR DELETE ON ai_inquiry_skill
  FOR EACH ROW EXECUTE FUNCTION ai_inquiry_is_immutable();

CREATE TRIGGER trg_ai_skill_command_execution_immutable
  BEFORE UPDATE OR DELETE ON ai_skill_command_execution
  FOR EACH ROW EXECUTE FUNCTION ai_inquiry_is_immutable();
