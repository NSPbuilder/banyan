-- Company switches constrain user grants, including owner access. Missing
-- switches stay enabled for compatibility; saving a company records every seat.
CREATE TABLE company_module_access (
  entity_id uuid NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
  module text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL,
  PRIMARY KEY (entity_id, module)
);
