-- =============================================================================
-- SEED — IFRS role taxonomy and statement templates
-- Run after schema.sql.
--
-- ROLES are the tags you put on accounts. They are the ONLY thing statements
-- reference, so each of your companies can keep its own chart of accounts
-- while sharing one set of financial statements.
--
-- FAMILIES
--   classification : where the account sits on the balance sheet / income
--                    statement. Every account gets exactly one.
--   nature         : IAS 1.99 "by nature" expense analysis (what was bought)
--   function        : IAS 1.99 "by function" expense analysis (what it was for)
--   cash_flow      : which activity a movement belongs to (indirect method)
--
-- An expense account normally carries ONE classification-or-nature role AND
-- ONE function role, so both IAS 1 income statement formats work off the same
-- chart without re-tagging anything.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- ASSETS (classification)
-- -----------------------------------------------------------------------------
INSERT INTO role_definition (code, label, category, family, is_contra, is_core, sort_order, description) VALUES
 ('cash_and_cash_equivalents','Cash and cash equivalents','asset','classification',false,true,100,'Bank accounts, petty cash, deposits maturing within 3 months'),
 ('restricted_cash','Restricted cash','asset','classification',false,false,101,'Cash not available for general use'),
 ('short_term_investments','Short-term investments','asset','classification',false,false,102,'GICs and marketable securities maturing within 12 months'),

 ('trade_receivables','Trade receivables','asset','classification',false,true,110,'Amounts billed to customers'),
 ('allowance_for_credit_losses','Allowance for credit losses','asset','classification',true,true,111,'IFRS 9 expected credit loss provision. Contra to trade receivables'),
 ('other_receivables','Other receivables','asset','classification',false,true,112,'Non-trade amounts owed to the company'),
 ('related_party_receivables','Receivables from related parties','asset','classification',false,true,113,'IAS 24. Balances with your other companies, shareholders, or their affiliates'),
 ('contract_assets','Contract assets','asset','classification',false,false,114,'IFRS 15. Revenue earned but not yet billable'),

 ('inventories','Inventories','asset','classification',false,false,120,'IAS 2. Goods held for sale, work in progress, raw materials'),
 ('prepaid_expenses','Prepaid expenses','asset','classification',false,true,121,'Insurance, subscriptions, rent paid in advance'),

 ('gst_hst_recoverable','GST/HST recoverable','asset','classification',false,true,130,'Input tax credits claimable from CRA'),
 ('qst_pst_recoverable','QST/PST recoverable','asset','classification',false,false,131,'Recoverable provincial sales tax (QC input tax refunds; most PST is not recoverable)'),
 ('income_tax_receivable','Income taxes receivable','asset','classification',false,false,132,'Instalments paid in excess of the year''s liability'),

 ('property_plant_equipment','Property, plant and equipment','asset','classification',false,true,140,'IAS 16, at cost'),
 ('accumulated_depreciation_ppe','Accumulated depreciation — PPE','asset','classification',true,true,141,'Contra to property, plant and equipment'),
 ('right_of_use_assets','Right-of-use assets','asset','classification',false,false,142,'IFRS 16. Leased premises, vehicles and equipment'),
 ('accumulated_depreciation_rou','Accumulated depreciation — right-of-use assets','asset','classification',true,false,143,'Contra to right-of-use assets'),
 ('investment_property','Investment property','asset','classification',false,false,144,'IAS 40. Real estate held to earn rent or for capital appreciation'),
 ('intangible_assets','Intangible assets','asset','classification',false,false,145,'IAS 38. Software, licences, customer lists'),
 ('accumulated_amortization_intangibles','Accumulated amortisation — intangibles','asset','classification',true,false,146,'Contra to intangible assets'),
 ('goodwill','Goodwill','asset','classification',false,false,147,'IFRS 3. Arises on business combination; not amortised'),

 ('long_term_investments','Long-term investments','asset','classification',false,false,150,'Investments held beyond 12 months'),
 ('investments_in_subsidiaries_and_associates','Investments in subsidiaries and associates','asset','classification',false,false,151,'IAS 27 / IAS 28. Shareholdings in your other companies'),

 ('deferred_tax_assets','Deferred tax assets','asset','classification',false,false,160,'IAS 12'),
 ('other_non_current_assets','Other non-current assets','asset','classification',false,false,161,'Deposits and anything not classified above');

-- -----------------------------------------------------------------------------
-- LIABILITIES (classification)
-- -----------------------------------------------------------------------------
INSERT INTO role_definition (code, label, category, family, is_contra, is_core, sort_order, description) VALUES
 ('bank_indebtedness','Bank indebtedness','liability','classification',false,true,200,'Operating line of credit and overdrafts'),

 ('trade_payables','Trade payables','liability','classification',false,true,210,'Amounts owed to suppliers'),
 ('accrued_liabilities','Accrued liabilities','liability','classification',false,true,211,'Expenses incurred but not yet invoiced'),
 ('related_party_payables','Payables to related parties','liability','classification',false,true,212,'IAS 24. Balances owed to your other companies or their affiliates'),
 ('contract_liabilities','Contract liabilities','liability','classification',false,true,213,'IFRS 15. Deferred revenue, customer deposits'),

 ('gst_hst_payable','GST/HST payable','liability','classification',false,true,220,'Tax collected on sales, owed to CRA'),
 ('qst_pst_payable','QST/PST payable','liability','classification',false,false,221,'Provincial sales tax collected'),
 ('payroll_liabilities','Payroll liabilities','liability','classification',false,true,222,'Source deductions (CPP, EI, income tax withheld), accrued wages and vacation pay'),
 ('income_tax_payable','Income taxes payable','liability','classification',false,true,223,'Current corporate income tax owing'),

 ('current_portion_of_borrowings','Current portion of borrowings','liability','classification',false,true,230,'Principal repayable within 12 months'),
 ('lease_liabilities_current','Lease liabilities — current','liability','classification',false,false,231,'IFRS 16 lease payments due within 12 months'),
 ('provisions_current','Provisions — current','liability','classification',false,false,232,'IAS 37. Warranties, restructuring, legal claims'),
 ('dividends_payable','Dividends payable','liability','classification',false,false,233,'Declared but unpaid'),
 ('due_to_shareholder','Due to shareholder','liability','classification',false,true,234,'Shareholder loans. Classify as current unless there are fixed repayment terms'),
 ('other_current_liabilities','Other current liabilities','liability','classification',false,true,235,'Anything current not classified above'),

 ('borrowings_non_current','Borrowings — non-current','liability','classification',false,true,240,'Term loans and mortgages beyond 12 months'),
 ('lease_liabilities_non_current','Lease liabilities — non-current','liability','classification',false,false,241,'IFRS 16 lease payments due beyond 12 months'),
 ('provisions_non_current','Provisions — non-current','liability','classification',false,false,242,'IAS 37'),
 ('deferred_tax_liabilities','Deferred tax liabilities','liability','classification',false,false,243,'IAS 12'),
 ('other_non_current_liabilities','Other non-current liabilities','liability','classification',false,false,244,'Anything non-current not classified above');

-- -----------------------------------------------------------------------------
-- EQUITY (classification)
-- -----------------------------------------------------------------------------
INSERT INTO role_definition (code, label, category, family, is_contra, is_core, sort_order, description) VALUES
 ('share_capital','Share capital','equity','classification',false,true,300,'Issued and paid-up capital'),
 ('contributed_surplus','Contributed surplus','equity','classification',false,false,301,'Capital contributions in excess of share capital'),
 ('retained_earnings','Retained earnings','equity','classification',false,true,302,'Accumulated profits of prior years, after the year-end closing entry'),
 ('dividends_declared','Dividends declared','equity','classification',true,true,303,'Contra to retained earnings; closed into it at year end'),
 ('accumulated_oci','Accumulated other comprehensive income','equity','classification',false,false,304,'IAS 1. Revaluation and translation reserves');

-- -----------------------------------------------------------------------------
-- INCOME (classification)
-- -----------------------------------------------------------------------------
INSERT INTO role_definition (code, label, category, family, is_contra, is_core, sort_order, description) VALUES
 ('revenue_from_contracts','Revenue from contracts with customers','revenue','classification',false,true,400,'IFRS 15. Your main operating revenue'),
 ('revenue_rental','Rental income','revenue','classification',false,false,401,'IFRS 16 lessor income'),
 ('other_income','Other income','revenue','classification',false,true,402,'Incidental income outside normal operations'),
 ('gain_on_disposal','Gain (loss) on disposal of assets','revenue','classification',false,false,403,'Proceeds less carrying amount'),
 ('finance_income','Finance income','revenue','classification',false,true,404,'Interest and dividend income. IAS 1 requires separate presentation'),
 ('government_grants_and_credits','Government grants and credits','revenue','classification',false,true,405,'IAS 20. SR&ED investment tax credits, wage subsidies, provincial grants'),
 ('foreign_exchange_gain_loss','Foreign exchange gain (loss)','revenue','classification',false,false,406,'IAS 21. Net realised and unrealised FX. Tag one account and let the sign decide');

-- -----------------------------------------------------------------------------
-- EXPENSES BY NATURE (IAS 1.99, "by nature" format)
-- -----------------------------------------------------------------------------
INSERT INTO role_definition (code, label, category, family, is_contra, is_core, sort_order, description) VALUES
 ('changes_in_inventories','Changes in inventories of finished goods and work in progress','expense','nature',false,false,500,'The by-nature format shows the inventory movement, not cost of sales'),
 ('raw_materials_and_consumables','Raw materials and consumables used','expense','nature',false,false,501,'Purchases of goods and materials consumed'),

 ('employee_benefits_expense','Employee benefits expense','expense','nature',false,true,510,'IAS 19. Wages, employer CPP/EI, benefits, vacation accrual'),

 ('depreciation_expense','Depreciation expense','expense','nature',false,true,520,'PPE and right-of-use assets'),
 ('amortization_expense','Amortisation expense','expense','nature',false,false,521,'Intangible assets'),
 ('impairment_loss','Impairment losses','expense','nature',false,false,522,'IAS 36 and IFRS 9 write-downs'),

 ('professional_fees','Professional fees','expense','nature',false,true,530,'Accounting, legal, consulting'),
 ('occupancy_expense','Occupancy costs','expense','nature',false,true,531,'Utilities, property tax, common area costs. Under IFRS 16 most rent becomes depreciation plus interest instead'),
 ('short_term_and_low_value_lease_expense','Short-term and low-value lease expense','expense','nature',false,true,532,'IFRS 16 recognition exemption: leases under 12 months or of low-value assets stay as expense'),
 ('office_and_administrative','Office and administrative','expense','nature',false,true,533,'Supplies, postage, telephone'),
 ('marketing_and_advertising','Marketing and advertising','expense','nature',false,true,534,NULL),
 ('travel_and_entertainment','Travel and entertainment','expense','nature',false,true,535,'Note: meals and entertainment are only 50% deductible for Canadian tax. Keep a separate account to make the T2 adjustment easy'),
 ('insurance_expense','Insurance','expense','nature',false,true,536,NULL),
 ('repairs_and_maintenance','Repairs and maintenance','expense','nature',false,false,537,NULL),
 ('technology_and_software','Technology and software','expense','nature',false,true,538,'Subscriptions, hosting, licences'),
 ('bank_charges','Bank charges','expense','nature',false,true,539,'Service fees and merchant processing costs, excluding interest'),
 ('other_operating_expenses','Other operating expenses','expense','nature',false,true,540,'Anything operating not classified above'),

 ('finance_costs','Finance costs','expense','nature',false,true,550,'Interest on borrowings and lease liabilities. IAS 1.82(b) requires a separate line'),

 ('income_tax_current','Current income tax expense','expense','nature',false,true,560,'IAS 12'),
 ('income_tax_deferred','Deferred income tax expense','expense','nature',false,false,561,'IAS 12');

-- -----------------------------------------------------------------------------
-- EXPENSES BY FUNCTION (IAS 1.99, "by function" format)
-- Tag the same accounts with these as well if you want the second format.
-- -----------------------------------------------------------------------------
INSERT INTO role_definition (code, label, category, family, is_contra, is_core, sort_order, description) VALUES
 ('fn_cost_of_sales','Cost of sales','expense','function',false,true,600,'Costs directly attributable to goods sold or services delivered'),
 ('fn_distribution_costs','Distribution costs','expense','function',false,false,601,'Selling, shipping, marketing'),
 ('fn_administrative_expenses','Administrative expenses','expense','function',false,true,602,'General and administrative overhead'),
 ('fn_research_and_development','Research and development','expense','function',false,false,603,'Useful if you claim SR&ED'),
 ('fn_other_expenses','Other expenses','expense','function',false,false,604,'Operating costs not fitting the functions above');

-- -----------------------------------------------------------------------------
-- CASH FLOW (indirect method). Roles only — the statement itself is a later phase.
-- -----------------------------------------------------------------------------
INSERT INTO role_definition (code, label, category, family, is_contra, is_core, sort_order, description) VALUES
 ('cf_operating','Operating activities','expense','cash_flow',false,true,700,'Working capital accounts whose movement belongs to operating cash flow'),
 ('cf_investing','Investing activities','expense','cash_flow',false,true,701,'Capital assets and investments'),
 ('cf_financing','Financing activities','expense','cash_flow',false,true,702,'Borrowings, leases, share capital, dividends'),
 ('cf_non_cash_adjustment','Non-cash adjustment','expense','cash_flow',false,true,703,'Depreciation, impairment and similar add-backs');
UPDATE role_definition SET category = NULL WHERE family = 'cash_flow';

-- =============================================================================
-- STATEMENT TEMPLATES
--
-- Reminder of the convention (see schema.sql): detail sums and formulas both
-- operate on RAW signed values (debit +, credit -). sign_flip is applied only
-- when rendering, so liabilities, equity and revenue show as positive numbers.
-- The balance check is: raw(TOTAL ASSETS) + raw(TOTAL LIABILITIES AND EQUITY) = 0
-- =============================================================================

INSERT INTO statement_template (code, name, statement_type, accounting_standard, locale) VALUES
 ('IFRS_SFP_EN',         'Statement of Financial Position',            'balance_sheet',    'IFRS', 'en-CA'),
 ('IFRS_PL_NATURE_EN',   'Statement of Profit or Loss (by nature)',    'income_statement', 'IFRS', 'en-CA'),
 ('IFRS_PL_FUNCTION_EN', 'Statement of Profit or Loss (by function)',  'income_statement', 'IFRS', 'en-CA');

-- ---------------------------------------------------------------- SFP --------
INSERT INTO statement_line (template_id, sort_order, indent, code, label, line_type, roles, formula, sign_flip, value_basis)
SELECT t.id, v.* FROM statement_template t, (VALUES
 ( 10,0,NULL::text,'ASSETS','header',                             '{}'::text[], NULL::text, false,'closing_balance'),
 ( 20,1,NULL,'Current assets','header',                           '{}'::text[], NULL, false,'closing_balance'),
 ( 30,2,'A_CASH','Cash and cash equivalents','detail',            ARRAY['cash_and_cash_equivalents','restricted_cash'], NULL, false,'closing_balance'),
 ( 40,2,'A_STI','Short-term investments','detail',                ARRAY['short_term_investments'], NULL, false,'closing_balance'),
 ( 50,2,'A_AR','Trade and other receivables','detail',            ARRAY['trade_receivables','allowance_for_credit_losses','other_receivables','related_party_receivables'], NULL, false,'closing_balance'),
 ( 60,2,'A_CTA','Contract assets','detail',                       ARRAY['contract_assets'], NULL, false,'closing_balance'),
 ( 70,2,'A_INV','Inventories','detail',                           ARRAY['inventories'], NULL, false,'closing_balance'),
 ( 80,2,'A_PPD','Prepaid expenses','detail',                      ARRAY['prepaid_expenses'], NULL, false,'closing_balance'),
 ( 90,2,'A_TAXR','Sales taxes recoverable','detail',              ARRAY['gst_hst_recoverable','qst_pst_recoverable'], NULL, false,'closing_balance'),
 (100,2,'A_ITR','Income taxes receivable','detail',               ARRAY['income_tax_receivable'], NULL, false,'closing_balance'),
 (110,1,'CA','Total current assets','total',                      '{}'::text[], 'A_CASH+A_STI+A_AR+A_CTA+A_INV+A_PPD+A_TAXR+A_ITR', false,'closing_balance'),
 (120,1,NULL,'Non-current assets','header',                       '{}'::text[], NULL, false,'closing_balance'),
 (130,2,'A_PPE','Property, plant and equipment','detail',         ARRAY['property_plant_equipment','accumulated_depreciation_ppe'], NULL, false,'closing_balance'),
 (140,2,'A_ROU','Right-of-use assets','detail',                   ARRAY['right_of_use_assets','accumulated_depreciation_rou'], NULL, false,'closing_balance'),
 (150,2,'A_IP','Investment property','detail',                    ARRAY['investment_property'], NULL, false,'closing_balance'),
 (160,2,'A_INT','Intangible assets','detail',                     ARRAY['intangible_assets','accumulated_amortization_intangibles'], NULL, false,'closing_balance'),
 (170,2,'A_GW','Goodwill','detail',                               ARRAY['goodwill'], NULL, false,'closing_balance'),
 (180,2,'A_INVST','Investments','detail',                         ARRAY['long_term_investments','investments_in_subsidiaries_and_associates'], NULL, false,'closing_balance'),
 (190,2,'A_DTA','Deferred tax assets','detail',                   ARRAY['deferred_tax_assets'], NULL, false,'closing_balance'),
 (200,2,'A_ONCA','Other non-current assets','detail',             ARRAY['other_non_current_assets'], NULL, false,'closing_balance'),
 (210,1,'NCA','Total non-current assets','total',                 '{}'::text[], 'A_PPE+A_ROU+A_IP+A_INT+A_GW+A_INVST+A_DTA+A_ONCA', false,'closing_balance'),
 (220,0,'TA','TOTAL ASSETS','total',                              '{}'::text[], 'CA+NCA', false,'closing_balance'),
 (230,0,NULL,'','spacer',                                         '{}'::text[], NULL, false,'closing_balance'),
 (240,0,NULL,'LIABILITIES AND EQUITY','header',                   '{}'::text[], NULL, false,'closing_balance'),
 (250,1,NULL,'Current liabilities','header',                      '{}'::text[], NULL, false,'closing_balance'),
 (260,2,'L_BANK','Bank indebtedness','detail',                    ARRAY['bank_indebtedness'], NULL, true,'closing_balance'),
 (270,2,'L_AP','Trade and other payables','detail',               ARRAY['trade_payables','accrued_liabilities','related_party_payables'], NULL, true,'closing_balance'),
 (280,2,'L_CTL','Contract liabilities','detail',                  ARRAY['contract_liabilities'], NULL, true,'closing_balance'),
 (290,2,'L_TAXP','Sales taxes payable','detail',                  ARRAY['gst_hst_payable','qst_pst_payable'], NULL, true,'closing_balance'),
 (300,2,'L_PAY','Payroll liabilities','detail',                   ARRAY['payroll_liabilities'], NULL, true,'closing_balance'),
 (310,2,'L_ITP','Income taxes payable','detail',                  ARRAY['income_tax_payable'], NULL, true,'closing_balance'),
 (320,2,'L_CPB','Current portion of borrowings','detail',         ARRAY['current_portion_of_borrowings'], NULL, true,'closing_balance'),
 (330,2,'L_LSC','Lease liabilities','detail',                     ARRAY['lease_liabilities_current'], NULL, true,'closing_balance'),
 (340,2,'L_PRVC','Provisions','detail',                           ARRAY['provisions_current'], NULL, true,'closing_balance'),
 (350,2,'L_DIVP','Dividends payable','detail',                    ARRAY['dividends_payable'], NULL, true,'closing_balance'),
 (360,2,'L_SHL','Due to shareholder','detail',                    ARRAY['due_to_shareholder'], NULL, true,'closing_balance'),
 (370,2,'L_OCL','Other current liabilities','detail',             ARRAY['other_current_liabilities'], NULL, true,'closing_balance'),
 (380,1,'CL','Total current liabilities','total',                 '{}'::text[], 'L_BANK+L_AP+L_CTL+L_TAXP+L_PAY+L_ITP+L_CPB+L_LSC+L_PRVC+L_DIVP+L_SHL+L_OCL', true,'closing_balance'),
 (390,1,NULL,'Non-current liabilities','header',                  '{}'::text[], NULL, false,'closing_balance'),
 (400,2,'L_BOR','Borrowings','detail',                            ARRAY['borrowings_non_current'], NULL, true,'closing_balance'),
 (410,2,'L_LSN','Lease liabilities','detail',                     ARRAY['lease_liabilities_non_current'], NULL, true,'closing_balance'),
 (420,2,'L_PRVN','Provisions','detail',                           ARRAY['provisions_non_current'], NULL, true,'closing_balance'),
 (430,2,'L_DTL','Deferred tax liabilities','detail',              ARRAY['deferred_tax_liabilities'], NULL, true,'closing_balance'),
 (440,2,'L_ONCL','Other non-current liabilities','detail',        ARRAY['other_non_current_liabilities'], NULL, true,'closing_balance'),
 (450,1,'NCL','Total non-current liabilities','total',            '{}'::text[], 'L_BOR+L_LSN+L_PRVN+L_DTL+L_ONCL', true,'closing_balance'),
 (460,1,'TL','Total liabilities','total',                         '{}'::text[], 'CL+NCL', true,'closing_balance'),
 (470,1,NULL,'Equity','header',                                   '{}'::text[], NULL, false,'closing_balance'),
 (480,2,'E_SC','Share capital','detail',                          ARRAY['share_capital'], NULL, true,'closing_balance'),
 (490,2,'E_CS','Contributed surplus','detail',                    ARRAY['contributed_surplus'], NULL, true,'closing_balance'),
 (500,2,'E_RE','Retained earnings','detail',                      ARRAY['retained_earnings','dividends_declared'], NULL, true,'closing_balance'),
 (505,2,'E_CYE','Profit for the period','current_earnings',       '{}'::text[], NULL, true,'period_movement'),
 (510,2,'E_AOCI','Accumulated other comprehensive income','detail',ARRAY['accumulated_oci'], NULL, true,'closing_balance'),
 (520,1,'EQ','Total equity','total',                              '{}'::text[], 'E_SC+E_CS+E_RE+E_CYE+E_AOCI', true,'closing_balance'),
 (530,0,'TLE','TOTAL LIABILITIES AND EQUITY','total',             '{}'::text[], 'TL+EQ', true,'closing_balance')
) AS v(sort_order,indent,code,label,line_type,roles,formula,sign_flip,value_basis)
WHERE t.code = 'IFRS_SFP_EN';

-- --------------------------------------------------- P&L, BY NATURE ----------
INSERT INTO statement_line (template_id, sort_order, indent, code, label, line_type, roles, formula, sign_flip, value_basis)
SELECT t.id, v.* FROM statement_template t, (VALUES
 ( 10,0,'P_REV','Revenue','detail',                               ARRAY['revenue_from_contracts','revenue_rental'], NULL::text, true,'period_movement'),
 ( 20,0,'P_OI','Other income','detail',                           ARRAY['other_income','gain_on_disposal','government_grants_and_credits'], NULL, true,'period_movement'),
 ( 30,0,'P_CHG','Changes in inventories of finished goods and work in progress','detail', ARRAY['changes_in_inventories'], NULL, false,'period_movement'),
 ( 40,0,'P_RM','Raw materials and consumables used','detail',     ARRAY['raw_materials_and_consumables'], NULL, false,'period_movement'),
 ( 50,0,'P_EMP','Employee benefits expense','detail',             ARRAY['employee_benefits_expense'], NULL, false,'period_movement'),
 ( 60,0,'P_DA','Depreciation and amortisation expense','detail',  ARRAY['depreciation_expense','amortization_expense'], NULL, false,'period_movement'),
 ( 70,0,'P_IMP','Impairment losses','detail',                     ARRAY['impairment_loss'], NULL, false,'period_movement'),
 ( 80,0,'P_OTH','Other expenses','detail',                        ARRAY['professional_fees','occupancy_expense','short_term_and_low_value_lease_expense','office_and_administrative','marketing_and_advertising','travel_and_entertainment','insurance_expense','repairs_and_maintenance','technology_and_software','bank_charges','other_operating_expenses'], NULL, false,'period_movement'),
 ( 90,0,'OP','Operating profit','total',                          '{}'::text[], 'P_REV+P_OI+P_CHG+P_RM+P_EMP+P_DA+P_IMP+P_OTH', true,'period_movement'),
 (100,0,'P_FI','Finance income','detail',                         ARRAY['finance_income'], NULL, true,'period_movement'),
 (110,0,'P_FC','Finance costs','detail',                          ARRAY['finance_costs'], NULL, false,'period_movement'),
 (120,0,'P_FX','Foreign exchange gain (loss)','detail',           ARRAY['foreign_exchange_gain_loss'], NULL, true,'period_movement'),
 (130,0,'PBT','Profit before tax','total',                        '{}'::text[], 'OP+P_FI+P_FC+P_FX', true,'period_movement'),
 (140,0,'P_TAX','Income tax expense','detail',                    ARRAY['income_tax_current','income_tax_deferred'], NULL, false,'period_movement'),
 (150,0,'PFY','Profit for the period','total',                    '{}'::text[], 'PBT+P_TAX', true,'period_movement')
) AS v(sort_order,indent,code,label,line_type,roles,formula,sign_flip,value_basis)
WHERE t.code = 'IFRS_PL_NATURE_EN';

-- ------------------------------------------------- P&L, BY FUNCTION ----------
INSERT INTO statement_line (template_id, sort_order, indent, code, label, line_type, roles, formula, sign_flip, value_basis)
SELECT t.id, v.* FROM statement_template t, (VALUES
 ( 10,0,'F_REV','Revenue','detail',                               ARRAY['revenue_from_contracts'], NULL::text, true,'period_movement'),
 ( 20,0,'F_COS','Cost of sales','detail',                         ARRAY['fn_cost_of_sales'], NULL, false,'period_movement'),
 ( 30,0,'GP','Gross profit','total',                              '{}'::text[], 'F_REV+F_COS', true,'period_movement'),
 ( 40,0,'F_OI','Other income','detail',                           ARRAY['other_income','gain_on_disposal','government_grants_and_credits','revenue_rental'], NULL, true,'period_movement'),
 ( 50,0,'F_DIST','Distribution costs','detail',                   ARRAY['fn_distribution_costs'], NULL, false,'period_movement'),
 ( 60,0,'F_ADM','Administrative expenses','detail',               ARRAY['fn_administrative_expenses'], NULL, false,'period_movement'),
 ( 70,0,'F_RD','Research and development','detail',               ARRAY['fn_research_and_development'], NULL, false,'period_movement'),
 ( 80,0,'F_OTH','Other expenses','detail',                        ARRAY['fn_other_expenses'], NULL, false,'period_movement'),
 ( 90,0,'FOP','Operating profit','total',                         '{}'::text[], 'GP+F_OI+F_DIST+F_ADM+F_RD+F_OTH', true,'period_movement'),
 (100,0,'F_FI','Finance income','detail',                         ARRAY['finance_income'], NULL, true,'period_movement'),
 (110,0,'F_FC','Finance costs','detail',                          ARRAY['finance_costs'], NULL, false,'period_movement'),
 (120,0,'F_FX','Foreign exchange gain (loss)','detail',           ARRAY['foreign_exchange_gain_loss'], NULL, true,'period_movement'),
 (130,0,'FPBT','Profit before tax','total',                       '{}'::text[], 'FOP+F_FI+F_FC+F_FX', true,'period_movement'),
 (140,0,'F_TAX','Income tax expense','detail',                    ARRAY['income_tax_current','income_tax_deferred'], NULL, false,'period_movement'),
 (150,0,'FPFY','Profit for the period','total',                   '{}'::text[], 'FPBT+F_TAX', true,'period_movement')
) AS v(sort_order,indent,code,label,line_type,roles,formula,sign_flip,value_basis)
WHERE t.code = 'IFRS_PL_FUNCTION_EN';
