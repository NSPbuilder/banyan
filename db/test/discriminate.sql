-- =============================================================================
-- DISCRIMINATION TEST — this file tests the TESTS, not the system.
--
-- A test that passes against the broken code it was written for proves nothing.
-- Three rounds of review found that shape here: smoke T11 (round 1) passed
-- because it queried an empty period; T6b/T6c and T15a-c (round 3) passed
-- against the very guards they were written to prove.
--
-- Each case below restores an OLD guard, replays the exact tamper the
-- corresponding test uses, and requires the old guard to LET IT THROUGH. If a
-- case fails, that test has stopped discriminating and is no longer evidence.
--
-- Runs after smoke.sql, reusing its fixture. Function definitions are restored
-- by ROLLBACK — DDL is transactional in PostgreSQL.
-- =============================================================================
\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;

CREATE OR REPLACE FUNCTION d_assert(p_ok boolean, p_label text, p_detail text DEFAULT '') RETURNS void AS $$
BEGIN
  IF NOT p_ok THEN
    RAISE EXCEPTION 'FAIL: % — % (this test no longer discriminates)', p_label, p_detail;
  END IF;
  RAISE NOTICE 'PASS  %  %', rpad(p_label, 52), p_detail;
END; $$ LANGUAGE plpgsql;

-- Snapshot the guards so D6 can prove they were actually put back, rather than
-- asserting something that would also hold against a stub.
CREATE TEMP TABLE d_baseline AS
SELECT p.oid::regprocedure::text AS fn, pg_get_functiondef(p.oid) AS def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('assert_period_open','forbid_posted_entry_mutation',
                     'check_balance_integrity','assert_entry_balanced',
                     'assert_entry_balanced_on_header','rebuild_period_balances',
                     'guard_period_redefinition','guard_year_redefinition');

CREATE TEMP TABLE d_fixture AS
SELECT id, status, closed_at, closed_by FROM fiscal_period
 WHERE ledger_id='aaaaaaaa-0000-0000-0000-000000000001';

-- The audit trigger fires on the reclose and again on the restore. Their
-- history is append-only, so remember where these two test events begin.
CREATE TEMP TABLE d_audit_mark AS
SELECT COALESCE(max(id), 0) AS high_water FROM audit_log;

-- smoke.sql leaves period 1 reopened; the period cases need it closed again.
-- Restored at the end from d_fixture.
UPDATE fiscal_period SET status='closed', closed_at=now(), closed_by='discriminate'
 WHERE ledger_id='aaaaaaaa-0000-0000-0000-000000000001' AND period_no=1;

-- =========================================================== CASE 1 =========
-- Restore assert_period_open as it stood BEFORE 0004: it checked only the
-- status of whatever period it was handed. T6b's tamper must slip through.
BEGIN;
  CREATE OR REPLACE FUNCTION assert_period_open() RETURNS trigger AS $f$
  DECLARE v_status text;
  BEGIN
    IF NEW.status <> 'posted' THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE' AND OLD.status = 'posted' THEN RETURN NEW; END IF;
    SELECT status INTO v_status FROM fiscal_period WHERE id = NEW.period_id;
    IF v_status IS NULL THEN
      RAISE EXCEPTION 'No fiscal period covers % in this ledger', NEW.entry_date;
    END IF;
    IF v_status <> 'open' THEN
      RAISE EXCEPTION 'Fiscal period is % — cannot post entry dated %', v_status, NEW.entry_date;
    END IF;
    RETURN NEW;
  END; $f$ LANGUAGE plpgsql;

  INSERT INTO journal_entry (id, ledger_id, entry_no, entry_date, period_id, description,
                             status, total_debit, total_credit, posted_at, posted_by)
  VALUES ('0d000000-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','JE-D-1','2026-01-20',
          (SELECT id FROM fiscal_period WHERE ledger_id='aaaaaaaa-0000-0000-0000-000000000001' AND period_no=2),
          'T6b tamper under the pre-0004 guard','posted', 10000, 10000,'2026-01-20','d');
  INSERT INTO journal_line (entry_id, line_no, account_id, amount) VALUES
    ('0d000000-0000-0000-0000-000000000001', 1, 'cccccccc-0000-0000-0000-000000001000',  10000),
    ('0d000000-0000-0000-0000-000000000001', 2, 'cccccccc-0000-0000-0000-000000004000', -10000);
  SET CONSTRAINTS ALL IMMEDIATE;

  SELECT d_assert(
    EXISTS (SELECT 1 FROM journal_entry WHERE id='0d000000-0000-0000-0000-000000000001'),
    'D1  T6b discriminates',
    'pre-0004 guard accepted a 2026-01-20 entry filed under 2026-02');
ROLLBACK;

-- =========================================================== CASE 2 =========
-- Same old guard: a period belonging to another ledger must slip through too.
BEGIN;
  CREATE OR REPLACE FUNCTION assert_period_open() RETURNS trigger AS $f$
  DECLARE v_status text;
  BEGIN
    IF NEW.status <> 'posted' THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE' AND OLD.status = 'posted' THEN RETURN NEW; END IF;
    SELECT status INTO v_status FROM fiscal_period WHERE id = NEW.period_id;
    IF v_status IS NULL THEN RAISE EXCEPTION 'No fiscal period covers %', NEW.entry_date; END IF;
    IF v_status <> 'open' THEN RAISE EXCEPTION 'Fiscal period is %', v_status; END IF;
    RETURN NEW;
  END; $f$ LANGUAGE plpgsql;

  INSERT INTO journal_entry (id, ledger_id, entry_no, entry_date, period_id, description,
                             status, total_debit, total_credit, posted_at, posted_by)
  VALUES ('0d000000-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','JE-D-2','2026-02-15',
          'bbbbbbbb-0000-0000-0000-0000000000f2',
          'T6c tamper under the pre-0004 guard','posted', 10000, 10000,'2026-02-15','d');
  INSERT INTO journal_line (entry_id, line_no, account_id, amount) VALUES
    ('0d000000-0000-0000-0000-000000000002', 1, 'cccccccc-0000-0000-0000-000000001000',  10000),
    ('0d000000-0000-0000-0000-000000000002', 2, 'cccccccc-0000-0000-0000-000000004000', -10000);
  SET CONSTRAINTS ALL IMMEDIATE;

  SELECT d_assert(
    EXISTS (SELECT 1 FROM journal_entry WHERE id='0d000000-0000-0000-0000-000000000002'),
    'D2  T6c discriminates',
    'pre-0004 guard accepted a period from another ledger');
ROLLBACK;

-- =========================================================== CASE 3 =========
-- Restore the 0004 guard, which looked only at status='posted', plus the 0004
-- immutability trigger and without 0005's CHECK. T6d's draft -> reversed path
-- must slip through — this is the round-3 Tier-1 bypass.
BEGIN;
  -- Restoring the world as it stood at 0004 means dropping what came after:
  -- the reversed-completeness constraint (0005) and the bare-draft constraint
  -- (0010). Leaving either in place would make this case pass because a LATER
  -- guard rejected the tamper, not because the 0005 gate was missing.
  ALTER TABLE journal_entry DROP CONSTRAINT journal_entry_reversed_complete;
  ALTER TABLE journal_entry DROP CONSTRAINT journal_entry_draft_is_bare;

  CREATE OR REPLACE FUNCTION assert_period_open() RETURNS trigger AS $f$
  DECLARE p RECORD;
  BEGIN
    IF NEW.status <> 'posted' THEN RETURN NEW; END IF;             -- the gap
    IF TG_OP = 'UPDATE' AND OLD.status = 'posted' THEN RETURN NEW; END IF;
    SELECT fp.status, fp.name, fp.ledger_id, fp.start_date, fp.end_date
      INTO p FROM fiscal_period fp WHERE fp.id = NEW.period_id;
    IF p IS NULL THEN RAISE EXCEPTION 'No fiscal period covers %', NEW.entry_date; END IF;
    IF p.ledger_id <> NEW.ledger_id THEN RAISE EXCEPTION 'Period % is another ledger''s', p.name; END IF;
    IF NEW.entry_date < p.start_date OR NEW.entry_date > p.end_date THEN
      RAISE EXCEPTION 'Entry dated % cannot be filed under %', NEW.entry_date, p.name; END IF;
    IF p.status <> 'open' THEN RAISE EXCEPTION 'Fiscal period is %', p.status; END IF;
    RETURN NEW;
  END; $f$ LANGUAGE plpgsql;

  CREATE OR REPLACE FUNCTION forbid_posted_entry_mutation() RETURNS trigger AS $f$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'Cannot delete posted entry %', OLD.id; END IF;
      RETURN OLD;
    END IF;
    IF OLD.status IN ('posted','reversed') THEN                     -- no draft rule
      IF NEW.total_debit IS DISTINCT FROM OLD.total_debit THEN
        RAISE EXCEPTION 'Posted entry % is immutable', OLD.id; END IF;
    END IF;
    RETURN NEW;
  END; $f$ LANGUAGE plpgsql;

  INSERT INTO journal_entry (id, ledger_id, entry_no, entry_date, period_id, description,
                             status, total_debit, total_credit, posted_at, posted_by)
  VALUES ('0d000000-0000-0000-0000-000000000003','aaaaaaaa-0000-0000-0000-000000000001','JE-D-3','2026-01-20',
          (SELECT id FROM fiscal_period WHERE ledger_id='aaaaaaaa-0000-0000-0000-000000000001' AND period_no=1),
          'T6d tamper under the 0004 guard','draft', 777700, 777700,'2026-01-20','d');
  INSERT INTO journal_line (entry_id, line_no, account_id, amount) VALUES
    ('0d000000-0000-0000-0000-000000000003', 1, 'cccccccc-0000-0000-0000-000000001000',  777700),
    ('0d000000-0000-0000-0000-000000000003', 2, 'cccccccc-0000-0000-0000-000000004000', -777700);
  UPDATE journal_entry SET status='reversed' WHERE id='0d000000-0000-0000-0000-000000000003';
  SET CONSTRAINTS ALL IMMEDIATE;

  SELECT d_assert(
    (SELECT status FROM journal_entry WHERE id='0d000000-0000-0000-0000-000000000003') = 'reversed',
    'D3  T6d discriminates',
    '0004 guard let $7,777.00 into closed 2026-01 as reversed');

ROLLBACK;

-- ========================================================== CASE 3b =========
-- T6e's own tamper: status='reversed' inserted straight into a closed period,
-- WITH balanced lines so the "has no lines" check cannot be what rejects it.
-- Its own transaction: SET CONSTRAINTS ALL IMMEDIATE stays in force for the
-- rest of a transaction, which would fire the header check before the lines
-- were inserted.
BEGIN;
  ALTER TABLE journal_entry DROP CONSTRAINT journal_entry_reversed_complete;

  CREATE OR REPLACE FUNCTION assert_period_open() RETURNS trigger AS $f$
  DECLARE p RECORD;
  BEGIN
    IF NEW.status <> 'posted' THEN RETURN NEW; END IF;             -- the gap
    IF TG_OP = 'UPDATE' AND OLD.status = 'posted' THEN RETURN NEW; END IF;
    SELECT fp.status, fp.name, fp.ledger_id, fp.start_date, fp.end_date
      INTO p FROM fiscal_period fp WHERE fp.id = NEW.period_id;
    IF p IS NULL THEN RAISE EXCEPTION 'No fiscal period covers %', NEW.entry_date; END IF;
    IF p.ledger_id <> NEW.ledger_id THEN RAISE EXCEPTION 'Period % is another ledger''s', p.name; END IF;
    IF NEW.entry_date < p.start_date OR NEW.entry_date > p.end_date THEN
      RAISE EXCEPTION 'Entry dated % cannot be filed under %', NEW.entry_date, p.name; END IF;
    IF p.status <> 'open' THEN RAISE EXCEPTION 'Fiscal period is %', p.status; END IF;
    RETURN NEW;
  END; $f$ LANGUAGE plpgsql;

  INSERT INTO journal_entry (id, ledger_id, entry_no, entry_date, period_id, description,
                             status, total_debit, total_credit, posted_at, posted_by)
  VALUES ('0d000000-0000-0000-0000-000000000004','aaaaaaaa-0000-0000-0000-000000000001','JE-D-4','2026-01-20',
          (SELECT id FROM fiscal_period WHERE ledger_id='aaaaaaaa-0000-0000-0000-000000000001' AND period_no=1),
          'T6e tamper under the 0004 guard','reversed', 500000, 500000,'2026-01-20','d');
  INSERT INTO journal_line (entry_id, line_no, account_id, amount) VALUES
    ('0d000000-0000-0000-0000-000000000004', 1, 'cccccccc-0000-0000-0000-000000001000',  500000),
    ('0d000000-0000-0000-0000-000000000004', 2, 'cccccccc-0000-0000-0000-000000004000', -500000);
  SET CONSTRAINTS ALL IMMEDIATE;

  SELECT d_assert(
    EXISTS (SELECT 1 FROM journal_entry WHERE id='0d000000-0000-0000-0000-000000000004'),
    'D3b T6e discriminates',
    '0004 guard accepted status=reversed straight into closed 2026-01');
ROLLBACK;

-- =========================================================== CASE 4 =========
-- Restore check_balance_integrity as it stood in 0003 — four checks, driven by
-- the JOURNAL rather than by period_balance. T15b's and T15c's tampering must
-- both go unseen.
BEGIN;
  CREATE OR REPLACE FUNCTION check_balance_integrity(p_ledger_id uuid)
  RETURNS TABLE (check_name text, account_code text, account_name text,
                 period_name text, expected bigint, found bigint) AS $f$
  BEGIN
    RETURN QUERY
    WITH truth AS (
      SELECT jl.account_id, fp.id AS period_id, fp.start_date,
             SUM(SUM(jl.amount)) OVER (PARTITION BY jl.account_id ORDER BY fp.start_date)::bigint AS bal
        FROM journal_entry je
        JOIN journal_line jl ON jl.entry_id = je.id
        JOIN fiscal_period fp ON fp.id = je.period_id
       WHERE je.ledger_id = p_ledger_id AND je.status IN ('posted','reversed')
       GROUP BY jl.account_id, fp.id, fp.start_date
    )
    SELECT 'closing_balance'::text, a.code, a.name, fp.name, t.bal, pb.closing_balance
      FROM truth t
      JOIN period_balance pb ON pb.account_id = t.account_id AND pb.period_id = t.period_id
                            AND pb.ledger_id = p_ledger_id
      JOIN account a ON a.id = t.account_id
      JOIN fiscal_period fp ON fp.id = t.period_id
     WHERE pb.closing_balance IS DISTINCT FROM t.bal;

    RETURN QUERY
    SELECT 'opening_plus_movement'::text, a.code, a.name, fp.name,
           (pb.opening_balance + pb.period_debit - pb.period_credit)::bigint, pb.closing_balance
      FROM period_balance pb
      JOIN account a ON a.id = pb.account_id
      JOIN fiscal_period fp ON fp.id = pb.period_id
     WHERE pb.ledger_id = p_ledger_id
       AND pb.closing_balance <> pb.opening_balance + pb.period_debit - pb.period_credit;

    RETURN QUERY
    SELECT 'period_balances_to_zero'::text, ''::text, ''::text, fp.name,
           0::bigint, SUM(pb.closing_balance)::bigint
      FROM period_balance pb JOIN fiscal_period fp ON fp.id = pb.period_id
     WHERE pb.ledger_id = p_ledger_id
     GROUP BY fp.name HAVING SUM(pb.closing_balance) <> 0;

    RETURN QUERY
    SELECT 'account_missing_from_period'::text, a.code, a.name, fp.name, 0::bigint, 0::bigint
      FROM fiscal_period fp
      CROSS JOIN (SELECT DISTINCT jl.account_id FROM journal_entry je
                    JOIN journal_line jl ON jl.entry_id = je.id
                   WHERE je.ledger_id = p_ledger_id AND je.status IN ('posted','reversed')) u
      JOIN account a ON a.id = u.account_id
     WHERE fp.ledger_id = p_ledger_id
       AND NOT EXISTS (SELECT 1 FROM period_balance pb
                        WHERE pb.ledger_id = p_ledger_id AND pb.period_id = fp.id
                          AND pb.account_id = u.account_id);
  END; $f$ LANGUAGE plpgsql;

  -- T15b's tamper: two accounts, equal and opposite, in a dormant period
  UPDATE period_balance SET opening_balance = opening_balance + 7700,
                            closing_balance = closing_balance + 7700
   WHERE ledger_id='aaaaaaaa-0000-0000-0000-000000000001'
     AND period_id=(SELECT id FROM fiscal_period WHERE ledger_id='aaaaaaaa-0000-0000-0000-000000000001' AND period_no=6)
     AND account_id=(SELECT id FROM account WHERE code='1000' AND entity_id='11111111-1111-1111-1111-111111111111');
  UPDATE period_balance SET opening_balance = opening_balance - 7700,
                            closing_balance = closing_balance - 7700
   WHERE ledger_id='aaaaaaaa-0000-0000-0000-000000000001'
     AND period_id=(SELECT id FROM fiscal_period WHERE ledger_id='aaaaaaaa-0000-0000-0000-000000000001' AND period_no=6)
     AND account_id=(SELECT id FROM account WHERE code='4000' AND entity_id='11111111-1111-1111-1111-111111111111');

  SELECT d_assert(
    NOT EXISTS (SELECT 1 FROM check_balance_integrity('aaaaaaaa-0000-0000-0000-000000000001'::uuid)),
    'D4  T15b discriminates',
    'the 0003 four-check function saw none of it');

  -- T15c's tamper, replayed exactly: two rows invented for never-posted
  -- accounts, opening = closing and equal-and-opposite, so the 0003 checks have
  -- nothing to catch. The assertion here is the NEGATION of T15c's own
  -- assertion (count > 0), unscoped — scoping it to one check_name would be the
  -- very "passes for the wrong reason" defect this file exists to catch.
  INSERT INTO period_balance (ledger_id, period_id, account_id, opening_balance, closing_balance)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000001',
          (SELECT id FROM fiscal_period WHERE ledger_id='aaaaaaaa-0000-0000-0000-000000000001' AND period_no=6),
          (SELECT id FROM account WHERE code='6000' AND entity_id='11111111-1111-1111-1111-111111111111'),  12300,  12300),
         ('aaaaaaaa-0000-0000-0000-000000000001',
          (SELECT id FROM fiscal_period WHERE ledger_id='aaaaaaaa-0000-0000-0000-000000000001' AND period_no=6),
          (SELECT id FROM account WHERE code='6100' AND entity_id='11111111-1111-1111-1111-111111111111'), -12300, -12300);

  SELECT d_assert(
    NOT EXISTS (SELECT 1 FROM check_balance_integrity('aaaaaaaa-0000-0000-0000-000000000001'::uuid)),
    'D5  T15c discriminates',
    'the 0003 four-check function reported nothing at all');
ROLLBACK;

-- =========================================================== CASE 6 =========
-- Without 0007's guard, a closed period's boundaries move freely — which is
-- how $77,777 dated 20 January reached "February" with no overlap at any
-- instant and both integrity checks silent after a rebuild.
BEGIN;
  DROP TRIGGER trg_period_redefinition ON fiscal_period;

  UPDATE fiscal_period SET end_date='2026-01-19'
   WHERE ledger_id='aaaaaaaa-0000-0000-0000-000000000001' AND period_no=1;

  SELECT d_assert(
    (SELECT end_date FROM fiscal_period
      WHERE ledger_id='aaaaaaaa-0000-0000-0000-000000000001' AND period_no=1) = DATE '2026-01-19',
    'D7  T6h discriminates',
    'without 0007 a closed period''s end date moved freely');

  UPDATE fiscal_period SET end_date='2026-02-20'
   WHERE ledger_id='aaaaaaaa-0000-0000-0000-000000000001' AND period_no=2;

  SELECT d_assert(
    (SELECT end_date FROM fiscal_period
      WHERE ledger_id='aaaaaaaa-0000-0000-0000-000000000001' AND period_no=2) = DATE '2026-02-20',
    'D8  T6j discriminates',
    'without 0007 a period holding posted entries still moved');
ROLLBACK;

-- Put period 1 back exactly as smoke.sql left it — including closed_at, which
-- check_entries_in_closed_periods compares posted_at against.
UPDATE fiscal_period fp
   SET status = b.status, closed_at = b.closed_at, closed_by = b.closed_by
  FROM d_fixture b
 WHERE b.id = fp.id
   AND (fp.status IS DISTINCT FROM b.status
     OR fp.closed_at IS DISTINCT FROM b.closed_at
     OR fp.closed_by IS DISTINCT FROM b.closed_by);

-- D6 has to be able to FAIL. Asserting "no drift" would also hold against a
-- stubbed-out check function — round 2 recorded exactly that defect. Compare
-- the live function bodies with the snapshot taken before any case ran, and
-- compare the fixture rows this file touched.
-- pg_get_functiondef must only ever see the six functions we care about;
-- left unscoped the planner can evaluate it against aggregates in pg_proc.
CREATE OR REPLACE FUNCTION d_live_guards()
RETURNS TABLE (fn text, def text) AS $$
  SELECT p.oid::regprocedure::text, pg_get_functiondef(p.oid)
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('assert_period_open','forbid_posted_entry_mutation',
                       'check_balance_integrity','assert_entry_balanced',
                       'assert_entry_balanced_on_header','rebuild_period_balances',
                       'guard_period_redefinition','guard_year_redefinition');
$$ LANGUAGE sql STABLE;

SELECT d_assert(
  (SELECT count(*) FROM d_live_guards()) = (SELECT count(*) FROM d_baseline)
  AND NOT EXISTS (
    SELECT 1 FROM d_baseline b
      JOIN d_live_guards() l ON l.fn = b.fn
     WHERE l.def IS DISTINCT FROM b.def),
  'D6a this file restored what it swapped',
  (SELECT count(*)::text || ' bodies match the snapshot taken before case 1' FROM d_baseline));

-- D6a's baseline is taken at the start of THIS run, so it proves the file put
-- things back — not that what it put back is the migrated code. These assert
-- that the guards actually carry what the latest migrations introduced, and
-- they fail against a stub or an older definition.
SELECT d_assert(
  (SELECT def FROM d_live_guards() WHERE fn = 'assert_period_open()')
    LIKE '%Fiscal year % is %',
  'D6d period gate is the 0006 definition', 'checks the fiscal year status');

SELECT d_assert(
  (SELECT def FROM d_live_guards() WHERE fn = 'guard_period_redefinition()')
    LIKE '%its dates cannot be changed%',
  'D6i period redefinition guard present (0007)', 'boundaries are not freely mutable');

SELECT d_assert(
  EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'journal_entry_draft_is_bare'),
  'D6j drafts must be bare (0010)', 'a draft cannot carry an entry number or a period');

SELECT d_assert(
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_entry_ledger_immutable' AND NOT tgisinternal),
  'D6k an entry cannot change ledger (0010)', 'a draft''s lines would point at another company''s accounts');

SELECT d_assert(
  (SELECT def FROM d_live_guards() WHERE fn = 'assert_period_open()')
    LIKE '%NEW.status NOT IN (''posted'', ''reversed'')%',
  'D6e period gate covers reversed (0005)', 'gate is not posted-only');

SELECT d_assert(
  (SELECT count(*) FROM regexp_matches(
     (SELECT def FROM d_live_guards() WHERE fn = 'check_balance_integrity(uuid)'),
     'RETURN QUERY', 'g')) = 7,
  'D6f integrity check still has 7 checks', 'not a stub, not the 0003 four-check version');

SELECT d_assert(
  (SELECT def FROM d_live_guards() WHERE fn = 'forbid_posted_entry_mutation()')
    LIKE '%cannot go straight to%',
  'D6g draft cannot become reversed (0005)', 'the draft transition rule is present');

-- Attestation, not a discrimination case: it confirms the restore above ran.
SELECT d_assert(
  NOT EXISTS (
    SELECT 1 FROM d_fixture b JOIN fiscal_period fp ON fp.id = b.id
     WHERE fp.status    IS DISTINCT FROM b.status
        OR fp.closed_at IS DISTINCT FROM b.closed_at
        OR fp.closed_by IS DISTINCT FROM b.closed_by),
  'D6b restore ran (status, closed_at, closed_by)', 'attestation, not a discrimination case');

SELECT d_assert(
  (SELECT count(*) FROM audit_log WHERE id > (SELECT high_water FROM d_audit_mark)) = 2
  AND (SELECT count(*) FROM audit_log WHERE id > (SELECT high_water FROM d_audit_mark)
        AND table_name = 'fiscal_period' AND action IN ('close_period', 'reopen_period')) = 2,
  'D6h test period changes are recorded', 'append-only history contains the reclose and restore');

SELECT d_assert(
  NOT EXISTS (SELECT 1 FROM check_balance_integrity('aaaaaaaa-0000-0000-0000-000000000001'::uuid)),
  'D6c ledger still healthy', 'current checks report no drift');

DROP FUNCTION d_live_guards();
DROP FUNCTION d_assert(boolean, text, text);
\echo ''
\echo '=== 8 DISCRIMINATION CASES (D1 D2 D3 D3b D4 D5 D7 D8) + ATTESTATIONS (D6*) ALL PASS ==='
