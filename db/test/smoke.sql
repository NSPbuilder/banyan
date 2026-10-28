-- =============================================================================
-- SMOKE TEST — proves the ledger kernel's invariants actually hold.
-- Run against a freshly migrated database:
--   psql -d erp_dev -f db/test/smoke.sql
-- Every check prints PASS or aborts with FAIL.
-- =============================================================================
\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;

-- This file seeds its own fixtures with fixed UUIDs, so it needs an empty
-- ledger. `npm run db:smoke` resets the database first; say so plainly if
-- someone runs the file by hand against a database that already has data.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM entity) THEN
    RAISE EXCEPTION E'smoke.sql needs an empty database.\nRun: npm run db:smoke  (it resets first), or: npm run db:reset';
  END IF;
END $$;

-- Assert that a statement is REJECTED by the database.
CREATE OR REPLACE FUNCTION t_expect_error(p_sql text, p_label text) RETURNS void AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
    EXECUTE 'SET CONSTRAINTS ALL IMMEDIATE';   -- force deferred triggers to fire now
    RAISE EXCEPTION 'FAIL:% — statement was accepted but should have been rejected', p_label;
  EXCEPTION WHEN others THEN
    IF SQLERRM LIKE 'FAIL:%' THEN RAISE; END IF;
    RAISE NOTICE 'PASS  %  -> rejected: %', rpad(p_label, 46), left(SQLERRM, 78);
  END;
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION t_assert(p_ok boolean, p_label text, p_detail text DEFAULT '') RETURNS void AS $$
BEGIN
  IF NOT p_ok THEN RAISE EXCEPTION 'FAIL: % %', p_label, p_detail; END IF;
  RAISE NOTICE 'PASS  %  %', rpad(p_label, 46), p_detail;
END; $$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------- fixtures --
INSERT INTO entity (id, code, name, province) VALUES
  ('11111111-1111-1111-1111-111111111111','ACME','Acme Consulting Inc.','ON'),
  ('22222222-2222-2222-2222-222222222222','BETA','Beta Holdings Inc.','ON');

INSERT INTO ledger (id, entity_id, code, name) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','PRIMARY','Acme — Primary'),
  ('aaaaaaaa-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','PRIMARY','Beta — Primary');

INSERT INTO fiscal_year (id, ledger_id, name, start_date, end_date) VALUES
  ('bbbbbbbb-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','FY2026','2026-01-01','2026-12-31');

INSERT INTO fiscal_period (fiscal_year_id, ledger_id, period_no, name, start_date, end_date)
SELECT 'bbbbbbbb-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001', n,
       to_char(make_date(2026, n, 1), 'YYYY-MM'),
       make_date(2026, n, 1),
       (make_date(2026, n, 1) + interval '1 month - 1 day')::date
FROM generate_series(1, 12) n;

INSERT INTO account (id, entity_id, code, name, account_type, normal_balance, is_postable) VALUES
  ('cccccccc-0000-0000-0000-000000001000','11111111-1111-1111-1111-111111111111','1000','Cash — Operating','asset','debit',true),
  ('cccccccc-0000-0000-0000-000000001200','11111111-1111-1111-1111-111111111111','1200','Accounts Receivable','asset','debit',true),
  ('cccccccc-0000-0000-0000-000000001999','11111111-1111-1111-1111-111111111111','1999','TOTAL ASSETS (header)','asset','debit',false),
  ('cccccccc-0000-0000-0000-000000002100','11111111-1111-1111-1111-111111111111','2100','GST/HST Payable','liability','credit',true),
  ('cccccccc-0000-0000-0000-000000003000','11111111-1111-1111-1111-111111111111','3000','Share Capital','equity','credit',true),
  ('cccccccc-0000-0000-0000-000000004000','11111111-1111-1111-1111-111111111111','4000','Service Revenue','revenue','credit',true),
  ('cccccccc-0000-0000-0000-000000005000','11111111-1111-1111-1111-111111111111','5000','Professional Fees','expense','debit',true),
  ('cccccccc-0000-0000-0000-000000006000','11111111-1111-1111-1111-111111111111','6000','Insurance (never used)','expense','debit',true),
  ('cccccccc-0000-0000-0000-000000006100','11111111-1111-1111-1111-111111111111','6100','Subscriptions (never used)','expense','debit',true),
  ('dddddddd-0000-0000-0000-000000001000','22222222-2222-2222-2222-222222222222','1000','Cash — Operating','asset','debit',true);

INSERT INTO account_role (account_id, role) VALUES
  ('cccccccc-0000-0000-0000-000000001000','cash_and_cash_equivalents'),
  ('cccccccc-0000-0000-0000-000000001200','trade_receivables'),
  ('cccccccc-0000-0000-0000-000000002100','gst_hst_payable'),
  ('cccccccc-0000-0000-0000-000000003000','share_capital'),
  ('cccccccc-0000-0000-0000-000000004000','revenue_from_contracts'),
  ('cccccccc-0000-0000-0000-000000005000','professional_fees'),
  ('cccccccc-0000-0000-0000-000000005000','fn_administrative_expenses');   -- same account, two families

INSERT INTO number_sequence (entity_id, doc_type, fiscal_year, prefix)
VALUES ('11111111-1111-1111-1111-111111111111','JE','FY2026','JE-2026-');

-- ================================================================= TEST 1 ===
-- A balanced entry posts. $10,000 share capital injected.
DO $$
DECLARE v_period uuid; v_entry uuid := gen_random_uuid();
BEGIN
  SELECT id INTO v_period FROM fiscal_period
   WHERE ledger_id='aaaaaaaa-0000-0000-0000-000000000001' AND period_no=1;

  INSERT INTO journal_entry (id, ledger_id, entry_no, entry_date, period_id, description,
                             source_type, status, total_debit, total_credit,
                             idempotency_key, posted_at, posted_by)
  VALUES (v_entry,'aaaaaaaa-0000-0000-0000-000000000001','JE-2026-00001','2026-01-15', v_period,
          'Initial share capital','opening_balance','posted', 1000000, 1000000,
          'seed:share-capital','2026-01-15','tester');

  INSERT INTO journal_line (entry_id, line_no, account_id, amount, description) VALUES
    (v_entry, 1, 'cccccccc-0000-0000-0000-000000001000',  1000000, 'Cash received'),
    (v_entry, 2, 'cccccccc-0000-0000-0000-000000003000', -1000000, 'Shares issued');
END $$;
SELECT t_assert((SELECT count(*) FROM journal_entry WHERE status='posted') = 1,
                'T1  balanced entry posts', '$10,000.00');

-- Second entry: a customer invoice with GST/HST, and a fee expense.
DO $$
DECLARE v_period uuid; v_e1 uuid := gen_random_uuid(); v_e2 uuid := gen_random_uuid();
BEGIN
  SELECT id INTO v_period FROM fiscal_period
   WHERE ledger_id='aaaaaaaa-0000-0000-0000-000000000001' AND period_no=2;

  INSERT INTO journal_entry (id, ledger_id, entry_no, entry_date, period_id, description,
                             source_type, status, total_debit, total_credit, posted_at, posted_by)
  VALUES (v_e1,'aaaaaaaa-0000-0000-0000-000000000001','JE-2026-00002','2026-02-10', v_period,
          'Invoice 1001 — consulting services','manual','posted', 565000, 565000,'2026-02-10','tester');
  INSERT INTO journal_line (entry_id, line_no, account_id, amount, description) VALUES
    (v_e1, 1, 'cccccccc-0000-0000-0000-000000001200',  565000, 'A/R — Client X'),
    (v_e1, 2, 'cccccccc-0000-0000-0000-000000004000', -500000, 'Consulting fees'),
    (v_e1, 3, 'cccccccc-0000-0000-0000-000000002100',  -65000, 'HST 13%');

  INSERT INTO journal_entry (id, ledger_id, entry_no, entry_date, period_id, description,
                             source_type, status, total_debit, total_credit, posted_at, posted_by)
  VALUES (v_e2,'aaaaaaaa-0000-0000-0000-000000000001','JE-2026-00003','2026-02-28', v_period,
          'Accounting fees','manual','posted', 120000, 120000,'2026-02-28','tester');
  INSERT INTO journal_line (entry_id, line_no, account_id, amount, description) VALUES
    (v_e2, 1, 'cccccccc-0000-0000-0000-000000005000',  120000, 'Year-end preparation'),
    (v_e2, 2, 'cccccccc-0000-0000-0000-000000001000', -120000, 'Paid by cheque');
END $$;

-- ================================================================= TEST 2 ===
SELECT t_expect_error($sql$
  INSERT INTO journal_entry (id, ledger_id, entry_no, entry_date, period_id, description,
                             status, total_debit, total_credit, posted_at, posted_by)
  VALUES ('eeeeeeee-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001',
          'JE-2026-09001','2026-03-01',
          (SELECT id FROM fiscal_period WHERE ledger_id='aaaaaaaa-0000-0000-0000-000000000001' AND period_no=3),
          'Deliberately out of balance','posted', 100000, 90000,'2026-03-01','tester');
  INSERT INTO journal_line (entry_id, line_no, account_id, amount) VALUES
    ('eeeeeeee-0000-0000-0000-000000000001', 1, 'cccccccc-0000-0000-0000-000000001000',  100000),
    ('eeeeeeee-0000-0000-0000-000000000001', 2, 'cccccccc-0000-0000-0000-000000004000',  -90000);
$sql$, 'T2  unbalanced entry');

-- ================================================================= TEST 3 ===
SELECT t_expect_error(
  $sql$UPDATE journal_entry SET entry_date = '2026-06-01' WHERE entry_no = 'JE-2026-00002'$sql$,
  'T3  edit posted entry date');

SELECT t_expect_error(
  $sql$UPDATE journal_entry SET total_debit = 999 WHERE entry_no = 'JE-2026-00002'$sql$,
  'T3b edit posted entry amount');

-- ================================================================= TEST 4 ===
SELECT t_expect_error(
  $sql$DELETE FROM journal_entry WHERE entry_no = 'JE-2026-00002'$sql$,
  'T4  delete posted entry');

-- ================================================================= TEST 5 ===
SELECT t_expect_error(
  $sql$UPDATE journal_line SET amount = 1 WHERE entry_id =
       (SELECT id FROM journal_entry WHERE entry_no='JE-2026-00002') AND line_no = 1$sql$,
  'T5  edit line of posted entry');

SELECT t_expect_error(
  $sql$DELETE FROM journal_line WHERE entry_id =
       (SELECT id FROM journal_entry WHERE entry_no='JE-2026-00002') AND line_no = 3$sql$,
  'T5b delete line of posted entry');

-- ================================================================= TEST 6 ===
UPDATE fiscal_period SET status='closed', closed_at=now(), closed_by='tester'
 WHERE ledger_id='aaaaaaaa-0000-0000-0000-000000000001' AND period_no=1;

SELECT t_expect_error($sql$
  INSERT INTO journal_entry (id, ledger_id, entry_no, entry_date, period_id, description,
                             status, total_debit, total_credit, posted_at, posted_by)
  VALUES (gen_random_uuid(),'aaaaaaaa-0000-0000-0000-000000000001','JE-2026-09002','2026-01-20',
          (SELECT id FROM fiscal_period WHERE ledger_id='aaaaaaaa-0000-0000-0000-000000000001' AND period_no=1),
          'Backdated into a closed period','posted', 100, 100,'2026-01-20','tester');
$sql$, 'T6  post into closed period');

-- ================================================================= TEST 7 ===
SELECT t_expect_error($sql$
  INSERT INTO journal_line (entry_id, line_no, account_id, amount) VALUES
    ((SELECT id FROM journal_entry WHERE entry_no='JE-2026-00003'), 9,
     'cccccccc-0000-0000-0000-000000001999', 100);
$sql$, 'T7  post to header account');

-- ================================================================= TEST 8 ===
SELECT t_expect_error($sql$
  INSERT INTO journal_line (entry_id, line_no, account_id, amount) VALUES
    ((SELECT id FROM journal_entry WHERE entry_no='JE-2026-00003'), 8,
     'dddddddd-0000-0000-0000-000000001000', 100);
$sql$, 'T8  post to another entity''s account');

-- ================================================================= TEST 9 ===
SELECT t_expect_error($sql$
  INSERT INTO journal_entry (id, ledger_id, entry_no, entry_date, period_id, description,
                             status, total_debit, total_credit, idempotency_key, posted_at, posted_by)
  VALUES (gen_random_uuid(),'aaaaaaaa-0000-0000-0000-000000000001','JE-2026-09003','2026-03-01',
          (SELECT id FROM fiscal_period WHERE ledger_id='aaaaaaaa-0000-0000-0000-000000000001' AND period_no=3),
          'Double-click replay','posted', 100, 100,'seed:share-capital','2026-03-01','tester');
$sql$, 'T9  duplicate idempotency key');

-- ================================================================ TEST 10 ===
SELECT t_assert((SELECT COALESCE(SUM(amount),0) FROM journal_line jl
                   JOIN journal_entry je ON je.id = jl.entry_id
                  WHERE je.status IN ('posted','reversed')) = 0,
                'T10 ledger is in balance', 'SUM(amount) = 0');

-- ================================================================ TEST 11 ===
-- period_balance is a CACHE. These checks prove it reconstructs the truth.
SELECT rebuild_period_balances('aaaaaaaa-0000-0000-0000-000000000001');

-- 11a every account that was ever posted to appears in EVERY period,
--     so a dormant account never drops off the balance sheet.
SELECT t_assert(
  (SELECT count(*) FROM period_balance
    WHERE ledger_id='aaaaaaaa-0000-0000-0000-000000000001')
  = (SELECT count(*) FROM fiscal_period WHERE ledger_id='aaaaaaaa-0000-0000-0000-000000000001')
  * (SELECT count(DISTINCT jl.account_id) FROM journal_entry je
       JOIN journal_line jl ON jl.entry_id=je.id
      WHERE je.ledger_id='aaaaaaaa-0000-0000-0000-000000000001'),
  'T11a every account present in every period',
  (SELECT count(*)::text || ' rows' FROM period_balance));

-- 11b opening + movement = closing, on every single row
SELECT t_assert(
  NOT EXISTS (SELECT 1 FROM period_balance
               WHERE closing_balance <> opening_balance + period_debit - period_credit),
  'T11b opening + movement = closing', 'no drift on any row');

-- 11c the cache agrees with the ledger, account by account, at year end
SELECT t_assert(
  NOT EXISTS (
    WITH truth AS (
      SELECT jl.account_id, SUM(jl.amount) AS bal
        FROM journal_entry je JOIN journal_line jl ON jl.entry_id = je.id
       WHERE je.ledger_id='aaaaaaaa-0000-0000-0000-000000000001'
         AND je.status IN ('posted','reversed')
       GROUP BY jl.account_id),
    cache AS (
      SELECT pb.account_id, pb.closing_balance AS bal
        FROM period_balance pb JOIN fiscal_period fp ON fp.id = pb.period_id
       WHERE pb.ledger_id='aaaaaaaa-0000-0000-0000-000000000001' AND fp.period_no = 12)
    SELECT 1 FROM truth FULL JOIN cache USING (account_id)
     WHERE truth.bal IS DISTINCT FROM cache.bal),
  'T11c cache matches journal_line exactly', 'per account, at year end');

-- 11d the balance sheet balances in EVERY period, not just at year end
SELECT t_assert(
  NOT EXISTS (SELECT 1 FROM period_balance
               WHERE ledger_id='aaaaaaaa-0000-0000-0000-000000000001'
               GROUP BY period_id HAVING SUM(closing_balance) <> 0),
  'T11d every period balances', 'SUM(closing_balance) = 0 for all 12 periods');

-- =============================================================== TEST 6b ===
-- The bypass a critic found: an entry DATED inside a closed period, filed
-- under a different, OPEN period. Before 0004 this was accepted with no
-- special privilege — backdating into filed figures was a matter of choosing
-- a different period_id.
-- Balanced lines, so the ONLY thing that can reject this is the period gate.
-- Without them the deferred "has no lines" check fires first and the test
-- passes even with the gate reverted.
SELECT t_expect_error($sql$
  INSERT INTO journal_entry (id, ledger_id, entry_no, entry_date, period_id, description,
                             status, total_debit, total_credit, posted_at, posted_by)
  VALUES ('dddddddd-0000-0000-0000-0000000006b0','aaaaaaaa-0000-0000-0000-000000000001','JE-2026-09005','2026-01-20',
          (SELECT id FROM fiscal_period WHERE ledger_id='aaaaaaaa-0000-0000-0000-000000000001' AND period_no=2),
          'Backdated into a closed period via an open period_id','posted', 10000, 10000,'2026-01-20','tester');
  INSERT INTO journal_line (entry_id, line_no, account_id, amount) VALUES
    ('dddddddd-0000-0000-0000-0000000006b0', 1, 'cccccccc-0000-0000-0000-000000001000',  10000),
    ('dddddddd-0000-0000-0000-0000000006b0', 2, 'cccccccc-0000-0000-0000-000000004000', -10000);
$sql$, 'T6b date must sit inside its period');

-- =============================================================== TEST 6c ===
-- A period belonging to another ledger must not be usable either.
INSERT INTO fiscal_year (id, ledger_id, name, start_date, end_date) VALUES
  ('bbbbbbbb-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000002','FY2026','2026-01-01','2026-12-31');
INSERT INTO fiscal_period (id, fiscal_year_id, ledger_id, period_no, name, start_date, end_date) VALUES
  ('bbbbbbbb-0000-0000-0000-0000000000f2','bbbbbbbb-0000-0000-0000-000000000002',
   'aaaaaaaa-0000-0000-0000-000000000002', 2, '2026-02', '2026-02-01', '2026-02-28');

SELECT t_expect_error($sql$
  INSERT INTO journal_entry (id, ledger_id, entry_no, entry_date, period_id, description,
                             status, total_debit, total_credit, posted_at, posted_by)
  VALUES ('dddddddd-0000-0000-0000-0000000006c0','aaaaaaaa-0000-0000-0000-000000000001','JE-2026-09006','2026-02-15',
          'bbbbbbbb-0000-0000-0000-0000000000f2',
          'Filed under another ledger''s period','posted', 10000, 10000,'2026-02-15','tester');
  INSERT INTO journal_line (entry_id, line_no, account_id, amount) VALUES
    ('dddddddd-0000-0000-0000-0000000006c0', 1, 'cccccccc-0000-0000-0000-000000001000',  10000),
    ('dddddddd-0000-0000-0000-0000000006c0', 2, 'cccccccc-0000-0000-0000-000000004000', -10000);
$sql$, 'T6c period must belong to the ledger');

-- =============================================================== TEST 6d ===
-- Everything downstream treats 'reversed' as real. Inserting a draft and then
-- flipping it to 'reversed' walked past the whole gate until 0005.
SELECT t_expect_error($sql$
  INSERT INTO journal_entry (id, ledger_id, entry_no, entry_date, period_id, description,
                             status, total_debit, total_credit, posted_at, posted_by)
  VALUES ('dddddddd-0000-0000-0000-0000000006d0','aaaaaaaa-0000-0000-0000-000000000001','JE-2026-09007','2026-01-20',
          (SELECT id FROM fiscal_period WHERE ledger_id='aaaaaaaa-0000-0000-0000-000000000001' AND period_no=1),
          'Draft smuggled into a closed period as reversed','draft', 777700, 777700,'2026-01-20','tester');
  INSERT INTO journal_line (entry_id, line_no, account_id, amount) VALUES
    ('dddddddd-0000-0000-0000-0000000006d0', 1, 'cccccccc-0000-0000-0000-000000001000',  777700),
    ('dddddddd-0000-0000-0000-0000000006d0', 2, 'cccccccc-0000-0000-0000-000000004000', -777700);
  UPDATE journal_entry SET status='reversed' WHERE id='dddddddd-0000-0000-0000-0000000006d0';
$sql$, 'T6d a draft cannot become reversed');

-- =============================================================== TEST 6e ===
-- The same status, inserted directly into a closed period.
SELECT t_expect_error($sql$
  INSERT INTO journal_entry (id, ledger_id, entry_no, entry_date, period_id, description,
                             status, total_debit, total_credit, posted_at, posted_by)
  VALUES ('dddddddd-0000-0000-0000-0000000006e0','aaaaaaaa-0000-0000-0000-000000000001','JE-2026-09008','2026-01-20',
          (SELECT id FROM fiscal_period WHERE ledger_id='aaaaaaaa-0000-0000-0000-000000000001' AND period_no=1),
          'Reversed status straight into a closed period','reversed', 500000, 500000,'2026-01-20','tester');
  INSERT INTO journal_line (entry_id, line_no, account_id, amount) VALUES
    ('dddddddd-0000-0000-0000-0000000006e0', 1, 'cccccccc-0000-0000-0000-000000001000',  500000),
    ('dddddddd-0000-0000-0000-0000000006e0', 2, 'cccccccc-0000-0000-0000-000000004000', -500000);
$sql$, 'T6e reversed obeys the period gate too');

-- =============================================================== TEST 6f ===
-- Creating a fiscal period is ordinary administration, so an open period
-- overlapping a closed one was a way into closed figures that needed no
-- privilege at all. A date must map to exactly one period.
SELECT t_expect_error($sql$
  INSERT INTO fiscal_period (fiscal_year_id, ledger_id, period_no, name, start_date, end_date, status)
  VALUES ('bbbbbbbb-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001',
          13,'2026-ADJ','2026-01-15','2026-01-31','open');
$sql$, 'T6f periods in a ledger cannot overlap');

-- =============================================================== TEST 6g ===
-- The year's status counts too, not just the period's.
UPDATE fiscal_year SET status='locked' WHERE id='bbbbbbbb-0000-0000-0000-000000000001';
SELECT t_expect_error($sql$
  INSERT INTO journal_entry (id, ledger_id, entry_no, entry_date, period_id, description,
                             status, total_debit, total_credit, posted_at, posted_by)
  VALUES ('dddddddd-0000-0000-0000-0000000006f0','aaaaaaaa-0000-0000-0000-000000000001','JE-2026-09009','2026-05-10',
          (SELECT id FROM fiscal_period WHERE ledger_id='aaaaaaaa-0000-0000-0000-000000000001' AND period_no=5),
          'Posting into a locked year through an open period','posted', 100, 100,'2026-05-10','tester');
  INSERT INTO journal_line (entry_id, line_no, account_id, amount) VALUES
    ('dddddddd-0000-0000-0000-0000000006f0', 1, 'cccccccc-0000-0000-0000-000000001000',  100),
    ('dddddddd-0000-0000-0000-0000000006f0', 2, 'cccccccc-0000-0000-0000-000000004000', -100);
$sql$, 'T6g a locked year blocks an open period');
UPDATE fiscal_year SET status='open' WHERE id='bbbbbbbb-0000-0000-0000-000000000001';

-- =============================================================== TEST 6h ===
-- 0006 stopped periods overlapping but left their boundaries editable. Shrink
-- closed January to the 19th and stretch February back to the 20th, and there
-- is no overlap at any instant — yet a 20 January entry lands in "February".
SELECT t_expect_error($sql$
  UPDATE fiscal_period SET end_date='2026-01-19'
   WHERE ledger_id='aaaaaaaa-0000-0000-0000-000000000001' AND period_no=1;
$sql$, 'T6h a closed period cannot be redefined');

-- =============================================================== TEST 6i ===
-- Reassigning a period to an open year made the locked-year check irrelevant.
SELECT t_expect_error($sql$
  INSERT INTO fiscal_year (id, ledger_id, name, start_date, end_date, status)
  VALUES ('bbbbbbbb-0000-0000-0000-00000000f027','aaaaaaaa-0000-0000-0000-000000000001',
          'FY2027','2027-01-01','2027-12-31','open');
  UPDATE fiscal_period SET fiscal_year_id='bbbbbbbb-0000-0000-0000-00000000f027'
   WHERE ledger_id='aaaaaaaa-0000-0000-0000-000000000001' AND period_no=5;
$sql$, 'T6i a period must sit inside its year');

-- =============================================================== TEST 6j ===
-- Even an OPEN period cannot be redefined once it holds posted entries.
SELECT t_expect_error($sql$
  UPDATE fiscal_period SET end_date='2026-02-20'
   WHERE ledger_id='aaaaaaaa-0000-0000-0000-000000000001' AND period_no=2;
$sql$, 'T6j a period holding entries cannot move');

-- =============================================================== TEST 6k ===
-- Redefining an empty, open period is legitimate — and must be recorded.
UPDATE fiscal_period SET end_date='2026-07-30'
 WHERE ledger_id='aaaaaaaa-0000-0000-0000-000000000001' AND period_no=7;
SELECT t_assert(
  EXISTS (SELECT 1 FROM audit_log WHERE action='redefine_period'),
  'T6k redefining a period is audited',
  (SELECT (before->>'end_date') || ' -> ' || (after->>'end_date')
     FROM audit_log WHERE action='redefine_period' ORDER BY occurred_at DESC LIMIT 1));
UPDATE fiscal_period SET end_date='2026-07-31'
 WHERE ledger_id='aaaaaaaa-0000-0000-0000-000000000001' AND period_no=7;

-- ================================================================ TEST 12 ===
-- The header totals must agree with the lines. Before this check existed, a
-- posted entry could carry balanced lines and a header saying anything at all
-- — and the header is what an entry screen displays.
SELECT t_expect_error($sql$
  INSERT INTO journal_entry (id, ledger_id, entry_no, entry_date, period_id, description,
                             status, total_debit, total_credit, posted_at, posted_by)
  VALUES ('ffffffff-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001',
          'JE-2026-09004','2026-03-02',
          (SELECT id FROM fiscal_period WHERE ledger_id='aaaaaaaa-0000-0000-0000-000000000001' AND period_no=3),
          'Balanced lines, lying header','posted', 999999, 12345,'2026-03-02','tester');
  INSERT INTO journal_line (entry_id, line_no, account_id, amount) VALUES
    ('ffffffff-0000-0000-0000-000000000001', 1, 'cccccccc-0000-0000-0000-000000001000',  10000),
    ('ffffffff-0000-0000-0000-000000000001', 2, 'cccccccc-0000-0000-0000-000000004000', -10000);
$sql$, 'T12 header totals must match the lines');

-- ================================================================ TEST 13 ===
-- Closing and reopening a period is the control that protects filed figures.
-- It must leave a trail however the change was made.
UPDATE fiscal_period SET status='open' WHERE ledger_id='aaaaaaaa-0000-0000-0000-000000000001' AND period_no=1;
SELECT t_assert(
  (SELECT count(*) FROM audit_log WHERE table_name='fiscal_period' AND action='close_period') >= 1
  AND (SELECT count(*) FROM audit_log WHERE table_name='fiscal_period' AND action='reopen_period') >= 1,
  'T13 period close/reopen is audited',
  (SELECT string_agg(action, ' -> ' ORDER BY occurred_at) FROM audit_log WHERE table_name='fiscal_period'));

-- ================================================================ TEST 14 ===
-- The read-only integrity check must come back empty on a healthy ledger...
SELECT t_assert(
  NOT EXISTS (SELECT 1 FROM check_balance_integrity('aaaaaaaa-0000-0000-0000-000000000001'::uuid)),
  'T14 integrity check is quiet when healthy', '0 findings');

-- ================================================================ TEST 15 ===
-- ...but an empty result proves nothing unless the check can also FAIL.
-- A stub returning nothing would pass T14. These corrupt period_balance on
-- purpose and require the check to notice, then put it back.
DO $$
DECLARE v_acct uuid; v_acct2 uuid; v_acct3 uuid; v_acct4 uuid; v_period uuid; v_period2 uuid; v_before bigint; v_found int;
BEGIN
  SELECT id INTO v_acct FROM account WHERE code='1000'
     AND entity_id='11111111-1111-1111-1111-111111111111';
  SELECT id INTO v_period FROM fiscal_period
   WHERE ledger_id='aaaaaaaa-0000-0000-0000-000000000001' AND period_no=2;

  -- (i) a closing balance that disagrees with the journal
  SELECT closing_balance INTO v_before FROM period_balance
   WHERE ledger_id='aaaaaaaa-0000-0000-0000-000000000001' AND period_id=v_period AND account_id=v_acct;
  UPDATE period_balance SET closing_balance = closing_balance + 50000
   WHERE ledger_id='aaaaaaaa-0000-0000-0000-000000000001' AND period_id=v_period AND account_id=v_acct;
  SELECT count(*) INTO v_found FROM check_balance_integrity('aaaaaaaa-0000-0000-0000-000000000001'::uuid);
  IF v_found = 0 THEN RAISE EXCEPTION 'FAIL: corrupted closing_balance went undetected'; END IF;
  UPDATE period_balance SET closing_balance = v_before
   WHERE ledger_id='aaaaaaaa-0000-0000-0000-000000000001' AND period_id=v_period AND account_id=v_acct;
  RAISE NOTICE 'PASS  %  corrupted closing_balance -> % finding(s)', rpad('T15a check detects a wrong closing balance',46), v_found;

  -- (ii) TWO accounts, equal and opposite, in a period where NEITHER has any
  --      journal activity. Movement stays zero on both rows, so opening+movement
  --      still equals closing; the two shifts cancel, so the period still sums
  --      to zero. Only comparing each stored figure with the journal catches it.
  --      A check driven by the journal rather than by period_balance never even
  --      looks at these rows.
  SELECT id INTO v_period2 FROM fiscal_period
   WHERE ledger_id='aaaaaaaa-0000-0000-0000-000000000001' AND period_no=6;
  SELECT id INTO v_acct2 FROM account WHERE code='4000'
     AND entity_id='11111111-1111-1111-1111-111111111111';

  UPDATE period_balance SET opening_balance = opening_balance + 7700,
                            closing_balance = closing_balance + 7700
   WHERE ledger_id='aaaaaaaa-0000-0000-0000-000000000001' AND period_id=v_period2 AND account_id=v_acct;
  UPDATE period_balance SET opening_balance = opening_balance - 7700,
                            closing_balance = closing_balance - 7700
   WHERE ledger_id='aaaaaaaa-0000-0000-0000-000000000001' AND period_id=v_period2 AND account_id=v_acct2;

  SELECT count(*) INTO v_found FROM check_balance_integrity('aaaaaaaa-0000-0000-0000-000000000001'::uuid);
  IF v_found = 0 THEN RAISE EXCEPTION 'FAIL: equal-and-opposite tampering in a dormant period went undetected'; END IF;
  IF EXISTS (SELECT 1 FROM check_balance_integrity('aaaaaaaa-0000-0000-0000-000000000001'::uuid)
              WHERE check_name IN ('opening_plus_movement','period_balances_to_zero')) THEN
    RAISE EXCEPTION 'FAIL: T15b was meant to slip past those two checks; it did not, so it is not testing the blind spot';
  END IF;
  PERFORM rebuild_period_balances('aaaaaaaa-0000-0000-0000-000000000001'::uuid);
  RAISE NOTICE 'PASS  %  2 accounts, equal and opposite, dormant period -> % finding(s)', rpad('T15b check detects balanced tampering',46), v_found;

  -- (iii) rows invented for accounts that have NEVER been posted to, shaped so
  --       that a check driven by the journal cannot see them at all: opening
  --       equals closing (so opening+movement=closing holds with zero movement)
  --       and the two are equal and opposite (so the period still sums to zero).
  --       Only comparing each stored row against the journal finds these.
  SELECT id INTO v_acct3 FROM account WHERE code='6000'
     AND entity_id='11111111-1111-1111-1111-111111111111';
  SELECT id INTO v_acct4 FROM account WHERE code='6100'
     AND entity_id='11111111-1111-1111-1111-111111111111';
  IF EXISTS (SELECT 1 FROM journal_line WHERE account_id IN (v_acct3, v_acct4)) THEN
    RAISE EXCEPTION 'FAIL: accounts 6000/6100 were supposed to be unused';
  END IF;

  INSERT INTO period_balance (ledger_id, period_id, account_id, opening_balance, closing_balance)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000001', v_period2, v_acct3,  12300,  12300),
         ('aaaaaaaa-0000-0000-0000-000000000001', v_period2, v_acct4, -12300, -12300);

  SELECT count(*) INTO v_found FROM check_balance_integrity('aaaaaaaa-0000-0000-0000-000000000001'::uuid);
  IF v_found = 0 THEN RAISE EXCEPTION 'FAIL: invented balance rows went undetected'; END IF;
  IF EXISTS (SELECT 1 FROM check_balance_integrity('aaaaaaaa-0000-0000-0000-000000000001'::uuid)
              WHERE check_name IN ('opening_plus_movement','period_balances_to_zero')) THEN
    RAISE EXCEPTION 'FAIL: T15c was meant to slip past those two checks; it did not, so it is not testing what it claims';
  END IF;
  RAISE NOTICE 'PASS  %  invented rows for unused accounts -> % finding(s)', rpad('T15c check detects invented rows',46), v_found;

  -- restore, and confirm the check goes quiet again
  PERFORM rebuild_period_balances('aaaaaaaa-0000-0000-0000-000000000001'::uuid);
  SELECT count(*) INTO v_found FROM check_balance_integrity('aaaaaaaa-0000-0000-0000-000000000001'::uuid);
  IF v_found <> 0 THEN RAISE EXCEPTION 'FAIL: rebuild left % finding(s)', v_found; END IF;
  RAISE NOTICE 'PASS  %  rebuild restores agreement', rpad('T15d rebuild clears the drift',46);
END $$;

-- =============================================================== REPORTS ====
\echo ''
\echo '--- TRIAL BALANCE (Acme, FY2026 period 02) ---------------------------------'
SELECT a.code, a.name,
       to_char(pb.period_debit /100.0,'FM999,999,990.00') AS debit,
       to_char(pb.period_credit/100.0,'FM999,999,990.00') AS credit,
       to_char(pb.closing_balance/100.0,'FM999,999,990.00') AS balance
  FROM period_balance pb
  JOIN account a ON a.id = pb.account_id
  JOIN fiscal_period fp ON fp.id = pb.period_id
 WHERE fp.period_no = 2 AND pb.ledger_id='aaaaaaaa-0000-0000-0000-000000000001'
 ORDER BY a.code;

\echo ''
\echo '--- ROLE-DRIVEN LOOKUP: what feeds "Cash and cash equivalents"? ------------'
SELECT sl.label, a.code, a.name
  FROM statement_line sl
  JOIN statement_template st ON st.id = sl.template_id
  JOIN account_role ar ON ar.role = ANY(sl.roles)
  JOIN account a ON a.id = ar.account_id
 WHERE st.code='IFRS_SFP_EN' AND sl.code='A_CASH'
   AND a.entity_id='11111111-1111-1111-1111-111111111111';

DROP FUNCTION t_expect_error(text,text);
DROP FUNCTION t_assert(boolean,text,text);
\echo ''
\echo '=== ALL CHECKS PASSED ==='
