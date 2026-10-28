/** Client-safe, release-reviewed catalogue. Historic records keep their own copy. */
export const CCA_POLICY = {
  version:'ca-cca-2026-10-12.1',verifiedOn:'2026-10-12',legislationCurrentTo:'2026-09-21',lastAmendedOn:'2026-06-18',
  sources:[
    {title:'Enacted Income Tax Regulations · section 1100',url:'https://laws-lois.justice.gc.ca/eng/regulations/C.R.C.,_c._945/section-1100.html'},
    {title:'CRA · CCA classes',url:'https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/sole-proprietorships-partnerships/report-business-income-expenses/claiming-capital-cost-allowance/classes.html'},
    {title:'CRA · Schedule 8 calculation guide',url:'https://www.canada.ca/en/revenue-agency/services/forms-publications/publications/t4012/t2-corporation-income-tax-guide-chapter-3-page-3-t2-return.html'},
    {title:'Enacted 2026 amendment · section 103',url:'https://laws-lois.justice.gc.ca/eng/AnnualStatutes/2026_3/section-103.html'},
    {title:'Finance · September 2026 Productivity Mega Deduction proposal',url:'https://www.canada.ca/en/department-finance/news/2026/09/government-of-canada-introduces-new-productivity-mega-deduction-to-boost-canadas-advantage-as-the-most-competitive-g7-country-for-new-business-inve.html'},
    {title:'Finance · September 2026 draft legislation',url:'https://www.canada.ca/en/department-finance/corporate/laws-regulations/draft-legislation/2026/09-itaitr-lirrir.html'}
  ],
  rules:[
    {title:'Ordinary class rates',detail:'Automatic standard pools use the prescribed ordinary rates for classes 1, 3, 6, 8, 10 and 50. Additional allowances, elections and special facts require a reviewed manual maximum.'},
    {title:'Class 50 · eligible 100% first year',detail:'Eligible AII property acquired after April 15, 2024, or eligible RII property acquired from January 1, 2025, and available for use before January 1, 2027, can receive the full first-year allowance. Review arm’s-length, prior ownership and rollover restrictions.'},
    {title:'AII and RII',detail:'Select eligibility explicitly. Standard AII enhancement phases down after 2023; RII enhancement applies before 2030 and phases down afterwards. Exceptional categories use reviewed manual calculation.'},
    {title:'Claim and annual review',detail:'The claim may be below the reviewed maximum. Review business-use allocation, assistance, short years, income limitations and special disposal treatment before recording.'},
    {title:'September 2026 draft · separate review',detail:'Finance published Productivity Mega Deduction proposals on September 15, 2026 for broader permanent immediate expensing. This catalogue does not automatically apply that draft. Check current enactment status and CRA filing guidance before entering a reviewed manual maximum or tax-basis adjustment.'}
  ],
  updateMethod:'Official sources are checked, calculation changes are tested, then a new catalogue version is released. Recorded years keep their original rule snapshot.'
} as const
