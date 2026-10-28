/**
 * One employee, one pay period: CPP, CPP2, EI, federal and BC income tax.
 *
 * A faithful port of the owner's AIBookkeeper engine (Python, Decimal) into
 * this repository's integer cents. Every rounding point is where T4127 puts
 * it, because that is what makes the answer match CRA's own calculator to the
 * cent — which two golden PDOC cases assert (`PR1`, `PR2`). The formulas are
 * T4127 Option 1, regular method:
 *
 *   A  = P × (I − F − U1 − F5A) − HD − F1        annual taxable income
 *   T3 = (R×A − K) − K1 − K2 − K4                federal, floored at zero
 *   T4 = (V×A − KP) − K1P − K2P                  BC, floored at zero
 *   T2 = T4 − S                                  BC after the tax reduction
 *
 * and the per-period tax is T1/P and T2/P rounded SEPARATELY and then added,
 * which is what PDOC does and is not the same as rounding the sum.
 *
 * What this file does NOT do, deliberately: the bonus/commission method, the
 * cumulative-averaging option, Quebec, or any province but BC. Each is its
 * own set of formulas, and a payroll engine that guesses at one is worse than
 * one that says it does not know.
 */
import {
  PayrollError,
  editionFor, type BcRates, type CppEiRates, type EditionId, type FederalRates, type RateEdition,
} from './rates'
import {
  add, asFrac, atRate, capped, clampAtLeastZero, cmp, div, dollars, lesser,
  mul, rate, roundFrac, sub, truncFrac, type Frac,
} from './exact'

/** Pay-period frequencies CRA supports, as periods per year (P). */
export const FREQUENCIES = {
  weekly: 52,
  biweekly: 26,
  semi_monthly: 24,
  monthly: 12,
  four_weekly: 13,
  twenty_two: 22,
  ten: 10,
} as const

export type Frequency = keyof typeof FREQUENCIES

export type PayPeriodInput = {
  /** 'YYYY-MM-DD'. Decides the edition — the pay date, not the work period. */
  payDate: string
  frequency: Frequency
  /** I — the period's taxable gross, in cents, benefits included. */
  gross: bigint
  /** Default: the gross. */
  pensionable?: bigint
  insurable?: bigint
  /** F — registered plan contributions withheld this period. */
  rppRrsp?: bigint
  /** U1 — union dues. */
  unionDues?: bigint
  /** TC — the federal claim. Defaults to the dynamic BPAF. */
  federalClaim?: bigint
  /** TCP — the BC claim. Defaults to the BC basic personal amount. */
  bcClaim?: bigint
  /** L — extra tax the employee asked for on their TD1. */
  additionalTax?: bigint
  /** Everything before this period, in the same calendar year. */
  ytdPensionable?: bigint
  ytdCpp?: bigint
  ytdCpp2?: bigint
  ytdEi?: bigint
}

export type PayrollResult = {
  edition: EditionId
  cpp: bigint
  cpp2: bigint
  ei: bigint
  federalTax: bigint
  provincialTax: bigint
  incomeTax: bigint
  employeeDeductions: bigint
  netPay: bigint
  employerCpp: bigint
  employerCpp2: bigint
  employerEi: bigint
  /** The trace T4127 readers expect to be able to follow. */
  annualTaxable: bigint
  federalAnnualTax: bigint
  provincialAnnualTax: bigint
}

export function calculatePayroll(
  input: PayPeriodInput,
  /** Editions to compute with instead of the ones on file — a candidate proved against PDOC before saving. */
  candidates?: RateEdition[],
): PayrollResult {
  const ed = editionFor(input.payDate, candidates)
  const bc = ed.bc
  const p = BigInt(FREQUENCIES[input.frequency])
  if (input.gross < 0n) {
    throw new PayrollError('NEGATIVE_GROSS', 'A pay period cannot be for less than nothing.')
  }

  const income = input.gross
  const pensionable = input.pensionable ?? income
  const insurable = input.insurable ?? income

  const { contribution: cpp, cpp2 } = calculateCpp(pensionable, p, {
    ytdPensionable: input.ytdPensionable ?? 0n,
    ytdCpp: input.ytdCpp ?? 0n,
    ytdCpp2: input.ytdCpp2 ?? 0n,
  }, ed.cppEi)
  const ei = calculateEi(insurable, input.ytdEi ?? 0n, ed.cppEi)

  // F5A — the CPP enhancement, which is deducted from income for tax (the
  // regular method has no B, so F5A is just F5).
  const enhancement = div(rate(ed.cppEi.cpp.firstAdditionalRate), rate(ed.cppEi.cpp.rate))
  const f5a = roundFrac(add(mul(asFrac(cpp), enhancement), asFrac(cpp2)))

  // A = P × (I − F − U1 − F5A). HD and F1 are not offered yet; when they are,
  // they subtract here, annually.
  const perPeriodNet = income - (input.rppRrsp ?? 0n) - (input.unionDues ?? 0n) - f5a
  const annual = clampAtLeastZero(p * perPeriodNet)
  const netIncome = annual // NI = A + HD, and HD is zero here.

  const annualCpp = p * cpp
  const annualEi = p * ei
  const employmentIncome = p * income

  const t1 = federalAnnualTax(annual, annualCpp, annualEi, employmentIncome, netIncome,
                              ed.federal, input.federalClaim, ed.cppEi)
  const { t2 } = bcAnnualTax(annual, annualCpp, annualEi, bc, input.bcClaim, ed.cppEi)

  // PDOC rounds the federal and provincial per-period figures separately and
  // then adds them. Rounding their sum instead is out by a cent often enough
  // to matter.
  const federalTax = roundFrac(div(asFrac(t1), asFrac(p)))
  const provincialTax = roundFrac(div(asFrac(t2), asFrac(p)))
  const incomeTax = clampAtLeastZero(federalTax + provincialTax + (input.additionalTax ?? 0n))

  const employeeDeductions = cpp + cpp2 + ei + incomeTax
  return {
    edition: ed.id,
    cpp, cpp2, ei,
    federalTax, provincialTax, incomeTax,
    employeeDeductions,
    netPay: income - employeeDeductions,
    // The employer matches CPP and CPP2 dollar for dollar, and pays 1.4× EI.
    employerCpp: cpp,
    employerCpp2: cpp2,
    employerEi: atRate(ei, rate(ed.cppEi.ei.employerMultiplier)),
    annualTaxable: annual,
    federalAnnualTax: t1,
    provincialAnnualTax: t2,
  }
}

/**
 * CPP (factor C) and the second additional contribution (C2).
 *
 * The per-period basic exemption is TRUNCATED to the cent, not rounded —
 * T4127 Table 6.1 publishes bi-weekly 3500/26 as 134.61, and a rounded
 * 134.62 is a cent of CPP wrong on every cheque.
 *
 * C2's band is cumulative: it is the part of the year's pensionable earnings
 * that falls between the first and second ceilings, so it can only be worked
 * out from the year to date.
 */
export function calculateCpp(pensionable: bigint, periodsPerYear: bigint, ytd: {
  ytdPensionable: bigint; ytdCpp: bigint; ytdCpp2: bigint
}, cppEi: CppEiRates) {
  const c = cppEi.cpp
  const periodExemption = truncFrac(div(asFrac(dollars(c.basicExemption)), asFrac(periodsPerYear)))
  const contributory = clampAtLeastZero(pensionable - periodExemption)
  const contribution = capped(atRate(contributory, rate(c.rate)),
                              dollars(c.maxContribution) - ytd.ytdCpp)

  const ympe = dollars(c.ympe)
  const yampe = dollars(c.yampe)
  const start = ytd.ytdPensionable
  const end = start + pensionable
  const lower = start > ympe ? start : ympe
  const upper = end < yampe ? end : yampe
  const inBand = clampAtLeastZero(upper - lower)
  const cpp2 = capped(atRate(inBand, rate(c.cpp2Rate)),
                      dollars(c.maxCpp2Contribution) - ytd.ytdCpp2)

  return { contribution, cpp2 }
}

/** EI: insurable earnings at the rate, capped at the annual maximum premium. */
export function calculateEi(insurable: bigint, ytdEi: bigint, cppEi: CppEiRates): bigint {
  const ei = cppEi.ei
  return capped(atRate(insurable, rate(ei.rate)), dollars(ei.maxPremium) - ytdEi)
}

/** The bracket a year's income falls in: its rate and its constant. */
function bracket(annual: bigint, tables: { thresholds: string[]; rates: string[]; constants: string[] }) {
  let index = 0
  tables.thresholds.forEach((t, i) => { if (annual >= dollars(t)) index = i })
  return { r: rate(tables.rates[index]), k: dollars(tables.constants[index]) }
}

/**
 * The federal Basic Personal Amount, which is not a constant: it slides from
 * its maximum down to its minimum across the top two brackets.
 */
export function bpaf(netIncome: bigint, federal: FederalRates): bigint {
  const b = federal.bpaf
  const lower = dollars(b.niLower)
  const upper = dollars(b.niUpper)
  if (netIncome <= lower) return dollars(b.max)
  if (netIncome >= upper) return dollars(b.min)
  const slope = div(rate(b.reductionNumerator), rate(b.reductionDenominator))
  return roundFrac(sub(asFrac(dollars(b.max)), mul(asFrac(netIncome - lower), slope)))
}

/**
 * K2 / K2P — the credit for the year's BASE CPP and EI. The base portion is
 * the unrounded 4.95/5.95 of the contribution, capped at the base maximum;
 * the enhancement is not creditable here, which is what F5A took out of
 * income instead.
 */
function cppEiCredit(creditRate: Frac, annualCpp: bigint, annualEi: bigint,
                     cppEi: CppEiRates): bigint {
  const c = cppEi.cpp
  const baseRatio = div(rate(c.baseRate), rate(c.rate))
  const base = lesser(mul(asFrac(annualCpp), baseRatio), asFrac(dollars(c.maxBaseContribution)))
  const eiCapped = lesser(asFrac(annualEi), asFrac(dollars(cppEi.ei.maxPremium)))
  return roundFrac(add(mul(creditRate, base), mul(creditRate, eiCapped)))
}

/** T1 — the annual federal tax deduction. */
export function federalAnnualTax(
  annual: bigint, annualCpp: bigint, annualEi: bigint, employmentIncome: bigint,
  netIncome: bigint, federal: FederalRates, claim: bigint | undefined,
  cppEi: CppEiRates,
): bigint {
  const { r, k } = bracket(annual, federal)
  const lowest = rate(federal.lowestRate)
  const tc = claim ?? bpaf(netIncome, federal)

  const k1 = atRate(tc, lowest)
  const k2 = cppEiCredit(lowest, annualCpp, annualEi, cppEi)
  const k4 = roundFrac(lesser(mul(asFrac(employmentIncome), lowest),
                              mul(asFrac(dollars(federal.cea)), lowest)))

  // Rounded ONCE, at the end: R×A is exact until here.
  const t3 = roundFrac(sub(mul(asFrac(annual), r), asFrac(k + k1 + k2 + k4)))
  return clampAtLeastZero(t3)
}

/** The BC tax reduction (factor S), which phases out with income. */
export function factorS(t4: bigint, annual: bigint, bc: BcRates): bigint {
  const tr = bc.taxReduction
  const full = dollars(tr.thresholdFull)
  const zero = dollars(tr.thresholdZero)
  const max = dollars(tr.maxCredit)
  let credit: bigint
  if (annual <= full) credit = max
  else if (annual <= zero) credit = roundFrac(sub(asFrac(max), mul(asFrac(annual - full), rate(tr.reductionRate))))
  else return 0n
  credit = clampAtLeastZero(credit)
  return t4 < credit ? t4 : credit
}

/** T2 — the annual BC tax deduction, and the T4 and S behind it. */
export function bcAnnualTax(
  annual: bigint, annualCpp: bigint, annualEi: bigint, bc: BcRates,
  claim: bigint | undefined, cppEi: CppEiRates,
): { t2: bigint; t4: bigint; s: bigint } {
  const { r: v, k: kp } = bracket(annual, bc)
  const lowest = rate(bc.lowestRate)
  const tcp = claim ?? dollars(bc.basicPersonalAmount)

  const k1p = atRate(tcp, lowest)
  const k2p = cppEiCredit(lowest, annualCpp, annualEi, cppEi)

  const t4 = clampAtLeastZero(roundFrac(sub(mul(asFrac(annual), v), asFrac(kp + k1p + k2p))))
  const s = factorS(t4, annual, bc)
  return { t2: clampAtLeastZero(t4 - s), t4, s }
}

/** The default claims — CRA's claim code 1, the basic amounts. */
export function basicClaims(payDate: string) {
  const ed = editionFor(payDate)
  return {
    federal: dollars(ed.federal.bpaf.max),
    bc: dollars(ed.bc.basicPersonalAmount),
  }
}

export { cmp }
