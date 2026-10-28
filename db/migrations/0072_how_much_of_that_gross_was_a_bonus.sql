-- HOW MUCH OF THAT GROSS WAS A BONUS.
--
-- The owner settled two SR&ED questions I had left open (2026-09-11): under the
-- traditional method the employer's share of CPP and EI belongs on T661 line
-- 360, and the prescribed proxy amount's salary base must EXCLUDE bonuses
-- rather than merely disclose that it does not. The second needs a fact this
-- system did not hold: `runPayroll` takes one undifferentiated `gross`, so
-- nothing could tell a bonus from a fortnight's salary.
--
-- THIS COLUMN CHANGES NO PAYROLL CALCULATION. It is a memo about the gross
-- already computed: CPP, EI, tax and the net pay are worked out exactly as
-- before, and this records how much of that same gross was a bonus. (Canada has
-- a separate bonus tax method; this is not it, and claiming otherwise by
-- letting this column reach the engine would be worse than not having it.)
-- The only reader is the SR&ED working paper.
ALTER TABLE pay_stub ADD COLUMN bonus bigint NOT NULL DEFAULT 0
  CHECK (bonus >= 0 AND bonus <= gross);
COMMENT ON COLUMN pay_stub.bonus IS
  'How much of `gross` was a bonus or profit-based pay. A memo: it changes no '
  'payroll figure, and exists because the SR&ED proxy salary base must exclude it.';
