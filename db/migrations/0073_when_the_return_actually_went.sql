-- WHEN THE RETURN ACTUALLY WENT, as opposed to the date written on it.
--
-- `filed_on` is a business date: the day the return is said to have gone, typed
-- by a person, and it is what the eighteen months are counted to. It cannot
-- answer "was this hour written down before or after we filed", because a row's
-- `created_at` is wall-clock and `filed_on` is not — a year filed today with a
-- date next June would make every record look early.
--
-- That question needs answering because adding time to a filed year is
-- deliberately still allowed (the project record goes on being kept) while the
-- allocation basis that quotes a share of those hours is frozen. The working
-- paper says so, and this is the column it reads.
ALTER TABLE sred_claim ADD COLUMN filed_at timestamptz;
COMMENT ON COLUMN sred_claim.filed_at IS
  'When the filing was recorded, wall clock. `filed_on` is the date on the return; this is '
  'the instant, so a record can be told apart from one written before it.';
