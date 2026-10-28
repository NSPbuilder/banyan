/**
 * The starter chart of accounts — GIFI-aligned (owner decision, 2026-09-02).
 *
 * Every code is a CRA GIFI item code — verified line by line against
 * RC4088(E) Rev.21 Appendix A — except the two invented siblings the next
 * paragraph explains. The T2 (schedules 100/125) mapping at tax time is
 * therefore one-to-one: the account code is the GIFI item. Names track the
 * GIFI item names, worded for daily use.
 *
 * Where two accounts belong to ONE GIFI item, the sibling takes the next
 * unassigned integer in the same block (GIFI leaves gaps): PST payable sits
 * at 2681 and income taxes at 2682, both filed under 2680 "Taxes payable" —
 * whose own description names GST/HST, sales taxes and income taxes. By the
 * same rule a second bank account would take 1008 (1003–1007 are real items).
 *
 * Role judgment calls, named rather than implied: no nature role exists for
 * vehicles or sub-contracts, so 9281 renders under travel_and_entertainment
 * and 9110 under other_operating_expenses; 8760, 9130 and 9225 sit in
 * office_and_administrative / other_operating_expenses for the same reason.
 *
 * Existing companies' charts are deliberately untouched — this is only what a
 * NEW company starts from (the import screen's prefill), and the codes the
 * tax-registration module proposes come from the same vocabulary
 * (registrations.ts). Roles, not codes, drive the statements; GIFI is the
 * coat of paint the CRA reads.
 *
 * Plain data, importable by the client form and the check suites alike.
 */
export const STARTER_CHART = `1001,Cash on hand,asset,,cash_and_cash_equivalents
1002,Bank — Chequing,asset,,cash_and_cash_equivalents
1060,Accounts receivable,asset,,trade_receivables
1061,Allowance for doubtful accounts,asset,,allowance_for_credit_losses,contra
1066,GST/HST recoverable,asset,,gst_hst_recoverable
1120,Inventories,asset,,inventories
1484,Prepaid expenses,asset,,prepaid_expenses
1740,Machinery and equipment,asset,,property_plant_equipment
1741,Accumulated amortization — machinery and equipment,asset,,accumulated_depreciation_ppe,contra
1774,Computer equipment and software,asset,,property_plant_equipment
1775,Accumulated amortization — computer equipment,asset,,accumulated_depreciation_ppe,contra
1787,Furniture and fixtures,asset,,property_plant_equipment
1788,Accumulated amortization — furniture and fixtures,asset,,accumulated_depreciation_ppe,contra
2620,Accrued liabilities,liability,,accrued_liabilities
2621,Trade payables,liability,,trade_payables
2627,Payroll liabilities,liability,,payroll_liabilities
2680,GST/HST payable,liability,,gst_hst_payable
2681,PST payable,liability,,qst_pst_payable
2682,Income taxes payable,liability,,income_tax_payable
2770,Deferred income,liability,,contract_liabilities
2780,Due to shareholder,liability,,due_to_shareholder
2783,Due to director,liability,,due_to_shareholder
3500,Common shares,equity,,share_capital
3600,Retained earnings,equity,,retained_earnings
8000,Sales of goods and services,revenue,,revenue_from_contracts
8090,Interest income,revenue,,finance_income
8140,Rental income,revenue,,revenue_rental
8230,Other revenue,revenue,,other_income
8320,Purchases and materials,expense,,raw_materials_and_consumables fn_cost_of_sales
8340,Direct wages,expense,,employee_benefits_expense fn_cost_of_sales
8360,Trades and subcontracts,expense,,other_operating_expenses fn_cost_of_sales
8450,Other direct costs,expense,,other_operating_expenses fn_cost_of_sales
8457,Freight-in and duty,expense,,other_operating_expenses fn_cost_of_sales
8520,Advertising and promotion,expense,,marketing_and_advertising fn_distribution_costs
8523,Meals and entertainment,expense,,travel_and_entertainment fn_administrative_expenses
8590,Bad debt expense,expense,,impairment_loss fn_administrative_expenses
8670,Amortization of tangible assets,expense,,depreciation_expense fn_administrative_expenses
8690,Insurance,expense,,insurance_expense fn_administrative_expenses
8710,Interest and bank charges,expense,,bank_charges fn_administrative_expenses
8760,"Business taxes, licences, and memberships",expense,,other_operating_expenses fn_administrative_expenses
8810,Office expenses,expense,,office_and_administrative fn_administrative_expenses
8860,Professional fees,expense,,professional_fees fn_administrative_expenses
8910,Rent,expense,,occupancy_expense fn_administrative_expenses
8960,Repairs and maintenance,expense,,repairs_and_maintenance fn_administrative_expenses
9060,Salaries and wages,expense,,employee_benefits_expense fn_administrative_expenses
9110,Sub-contracts,expense,,other_operating_expenses fn_cost_of_sales
9130,Supplies,expense,,office_and_administrative fn_administrative_expenses
9150,Computer-related expenses,expense,,technology_and_software fn_administrative_expenses
9200,Travel,expense,,travel_and_entertainment fn_administrative_expenses
9220,Utilities,expense,,occupancy_expense fn_administrative_expenses
9225,Telephone and telecommunications,expense,,office_and_administrative fn_administrative_expenses
9270,Other expenses,expense,,other_operating_expenses fn_other_expenses
9281,Vehicle expenses,expense,,travel_and_entertainment fn_administrative_expenses`
