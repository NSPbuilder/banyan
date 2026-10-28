-- =============================================================================
-- 0012 — corrections found by review of the statement renderer.
--
-- 1. The current-earnings line was seeded with value_basis 'period_movement',
--    but the renderer computes year-to-date and must: a balance sheet needs the
--    result accumulated since the year began, and the period's own movement
--    would leave every earlier month of the year on neither side. The column
--    described something the code does not do, and editing it would have had no
--    effect. 'closing_balance' is the honest label for an accumulating figure.
-- =============================================================================

UPDATE statement_line
   SET value_basis = 'closing_balance'
 WHERE line_type = 'current_earnings';

COMMENT ON COLUMN statement_line.value_basis IS
  'Which figure a DETAIL line pulls: closing_balance or period_movement. Ignored on current_earnings lines, which are always year-to-date.';
