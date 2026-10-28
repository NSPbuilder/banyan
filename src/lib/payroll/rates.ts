/**
 * The CRA's own numbers, as data.
 *
 * Ported from the AIBookkeeper project (owner's, 2026-07), where every figure
 * was read off the official T4127 PDF page by page rather than remembered.
 * They stay data for the reason they were data there: a wrong number is then
 * a one-line fix and a failing PDOC case, never something buried in an
 * expression.
 *
 * Amounts are written as decimal STRINGS and parsed into integer cents;
 * rates are written as decimal strings and parsed into exact fractions. No
 * float ever touches a payroll figure — see `exact.ts`.
 *
 * CRA issues T4127 editions that take effect on a date (for 2026: the 122nd
 * on 1 January and the 123rd on 1 July). Which one applies is decided by the
 * PAY DATE, not by the work period.
 */

import { problemsWith, problemsWithList } from './rates-check'

/** An edition's name, which is how a pay stub says which numbers made it. */
export type EditionId = string

export type CppEiRates = {
  cpp: {
    ympe: string; yampe: string; basicExemption: string
    rate: string; maxContribution: string
    baseRate: string; maxBaseContribution: string
    firstAdditionalRate: string
    cpp2Rate: string; maxCpp2Contribution: string
  }
  /**
   * `mie` — the maximum insurable earnings — is carried for the record and is
   * deliberately not what the engine caps on: capping the PREMIUM at
   * `maxPremium` is the same rule said once (68,900.00 × 1.63% = 1,123.07), and
   * two ceilings on one thing is two places for a year's update to be half
   * applied. `PR7` pins the premium ceiling; this line is why there is no
   * second one.
   */
  ei: { mie: string; rate: string; maxPremium: string; employerMultiplier: string }
}

/**
 * T4127 122nd Edition, Tables 8.3–8.7. CPP and EI are unchanged between the
 * January and July 2026 editions.
 */
export const CPP_EI_2026: CppEiRates = {
  cpp: {
    ympe: '74600.00',
    yampe: '85000.00',
    basicExemption: '3500.00',
    rate: '0.0595',
    maxContribution: '4230.45',
    baseRate: '0.0495',
    maxBaseContribution: '3519.45',
    firstAdditionalRate: '0.0100',
    cpp2Rate: '0.0400',
    maxCpp2Contribution: '416.00',
  },
  ei: {
    mie: '68900.00',
    rate: '0.0163',
    maxPremium: '1123.07',
    employerMultiplier: '1.4',
  },
}

export type TaxRates = {
  /** Bracket floors, in dollars. */
  thresholds: string[]
  /** The rate in each bracket (R federally, V for BC). */
  rates: string[]
  /** The constant subtracted in each bracket (K federally, KP for BC). */
  constants: string[]
  lowestRate: string
}

export type FederalRates = TaxRates & {
  bpaf: {
    max: string; min: string
    niLower: string; niUpper: string
    reductionNumerator: string; reductionDenominator: string
  }
  cea: string
}

export type BcRates = TaxRates & {
  basicPersonalAmount: string
  taxReduction: {
    maxCredit: string; thresholdFull: string; thresholdZero: string; reductionRate: string
    /**
     * Where a figure that fails the phase-out identity was read and found to
     * be what CRA published — for THIS edition, named, so a later table built
     * by spreading this one does not inherit the confirmation with the
     * numbers. Present and naming the edition, the checker stops asking.
     */
    confirmed?: { edition: string; source: string }
  }
}

/**
 * Federal: T4127 122nd Edition, Table 8.1 (R, A, K) and Table 8.2 (BPAF, CEA).
 * The 123rd (July) edition leaves every federal figure unchanged — only BC,
 * NL and PE moved — so both editions point at this one object rather than
 * carrying two copies of the same numbers to drift apart.
 */
export const FEDERAL_2026: FederalRates = {
  thresholds: ['0', '58523', '117045', '181440', '258482'],
  rates: ['0.1400', '0.2050', '0.2600', '0.2900', '0.3300'],
  constants: ['0', '3804', '10241', '15685', '26024'],
  lowestRate: '0.1400',
  bpaf: {
    max: '16452.00',
    min: '14829.00',
    niLower: '181440',
    niUpper: '258482',
    reductionNumerator: '1623',
    reductionDenominator: '77042',
  },
  cea: '1501.00',
}

/** BC: T4127 122nd Edition, Table 8.1 (V, A, KP) and Table 8.2 (S2 = 575). */
export const BC_2026_01: BcRates = {
  thresholds: ['0', '50363', '100728', '115648', '140430', '190405', '265545'],
  rates: ['0.0506', '0.0770', '0.1050', '0.1229', '0.1470', '0.1680', '0.2050'],
  constants: ['0', '1330', '4150', '6220', '9604', '13603', '23428'],
  lowestRate: '0.0506',
  basicPersonalAmount: '13216.00',
  taxReduction: {
    maxCredit: '575.00',
    thresholdFull: '25570',
    thresholdZero: '41722',
    reductionRate: '0.0356',
  },
}

/**
 * BC: T4127 123rd Edition (1 July 2026). BC's lowest rate is PRORATED to
 * 6.14% for the second half of 2026 — a mid-year true-up of the 5.06% → 5.60%
 * change — and the KP constants and the tax reduction move with it. This is
 * the reason the edition exists at all, and the reason a pay date in July
 * must not be computed with January's numbers.
 */
export const BC_2026_07: BcRates = {
  thresholds: ['0', '50363', '100728', '115648', '140430', '190405', '265545'],
  rates: ['0.0614', '0.0770', '0.1050', '0.1229', '0.1470', '0.1680', '0.2050'],
  constants: ['0', '786', '3606', '5676', '9061', '13059', '22884'],
  lowestRate: '0.0614',
  basicPersonalAmount: '13216.00',
  taxReduction: {
    maxCredit: '805.00',
    thresholdFull: '25570',
    thresholdZero: '44952',
    reductionRate: '0.0356',
    // T4127 123rd edition (July 2026), BC, Option 1: "Where $25,570 < A ≤
    // $44,952: S = $805 − [(A − $25,570) × 3.56%]". Budget raised the basic
    // reduction from $562 to $690; the indexed $575 (on file as BC_2026_01)
    // was used for January–June, so $805 for July–December brings the year to
    // $690. The endpoints and the rate are the annual ones. So the published
    // formula itself pays $115.00 at $44,952 and nothing at $44,953 — that
    // step is CRA's, and the engine follows the table as written rather than
    // smoothing it (canada.ca, read 2026-09-13).
    confirmed: {
      edition: '2026-07',
      source: 'T4127 123rd ed. (July 2026), BC Option 1 — the maximum is prorated to $805, '
        + 'the endpoints and rate are annual; the $115 step at $44,952 is in the published formula.',
    },
  },
}

export class PayrollError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'PayrollError'
  }
}

/**
 * One T4127 edition: the day it takes over, and every number it carries.
 *
 * ADDING A YEAR IS ADDING AN ENTRY TO THE LIST BELOW. It used to be editing
 * `editionFor`, which is why there was nowhere to put 2027 — the year was
 * written into the function as a comparison (owner, 2026-09-12).
 * `docs/design/35-the-cra-numbers.md` says which T4127 table each field is on;
 * `rates-check.ts` re-derives the ones that can be derived and refuses the
 * edition if they disagree.
 */
export type RateEdition = {
  id: EditionId
  /** The first pay date this edition governs. */
  startsOn: string
  /** Which T4127 edition, and what moved in it. For whoever adds the next. */
  authority: string
  cppEi: CppEiRates
  federal: FederalRates
  bc: BcRates
}

/**
 * IN ORDER, EARLIEST FIRST. An edition governs from its own `startsOn` until
 * the next one begins — and the LAST one governs only to the end of its own
 * year, which is what makes an uncovered year refuse instead of quietly
 * inheriting the newest tables it can find.
 */
export const EDITIONS: RateEdition[] = [
  {
    id: '2026-01',
    startsOn: '2026-01-01',
    authority: 'T4127 122nd Edition, effective 1 January 2026.',
    cppEi: CPP_EI_2026,
    federal: FEDERAL_2026,
    bc: BC_2026_01,
  },
  {
    id: '2026-07',
    startsOn: '2026-07-01',
    authority: "T4127 123rd Edition, effective 1 July 2026. Only BC, NL and PE moved; "
      + "BC's lowest rate was prorated to 6.14% as a mid-year true-up of the 5.06% → 5.60% "
      + 'change, and the KP constants and the tax reduction moved with it.',
    cppEi: CPP_EI_2026,
    federal: FEDERAL_2026,
    bc: BC_2026_07,
  },
]

/**
 * EDITIONS ADDED IN THE APP (0082), after the ones built in above.
 *
 * The owner asked how to tell the app about a new T4127 without a release
 * (2026-09-16). An edition added on the payroll screen is a row in
 * `payroll_rate_edition`; `editions.ts` reads those rows and hands them here
 * before anything is computed, and they join the list AFTER the built-in ones —
 * never before or between, which the list rules refuse.
 *
 * What that buys, and what it does not: a door that forgot to load them finds
 * no tables for a YEAR only an added edition covers, and refuses by name. But
 * an edition added later inside a year that already has tables — an October
 * after a July — would be missed by such a door, which would compute those
 * dates with the July tables. So loading is not optional: every door that
 * computes calls `loadEditions()` (PR61, S39), and a new door must too
 * (independent critic, 2026-09-16, corrected the earlier "never").
 */
let added: RateEdition[] = []
let addedVersion = 0

/** Replace the editions added in the app — `editions.ts` calls this with what the database holds. */
export function setAddedEditions(list: RateEdition[]): void {
  added = list
  addedVersion += 1
}

/** Every edition this process knows: the built-in ones, then the ones added in the app. */
export const editionsOnFile = (): RateEdition[] => [...EDITIONS, ...added]

/** The last pay date any edition on file governs. */
export function lastCoveredDate(list: RateEdition[] = editionsOnFile()): string {
  const last = list[list.length - 1]
  return last ? `${last.startsOn.slice(0, 4)}-12-31` : '(no tables at all)'
}

/** The years the tables on file describe, in order. */
export const coveredYears = (): number[] =>
  [...new Set(editionsOnFile().map((e) => Number(e.startsOn.slice(0, 4))))].sort((a, b) => a - b)

/**
 * Which edition a pay date falls in — and a refusal, by name, for a date past
 * the end of what is on file. Computing 2027 with 2026's tables would be wrong
 * by a few dollars every payday and look perfectly normal, which is the one
 * failure a payroll engine must not have.
 */
export function editionFor(
  payDate: string,
  /**
   * A list to look in instead of the one on file — a candidate edition being
   * proved against a PDOC case before it is saved (`editions.ts`). Checked by
   * the same list rules, every time, since it is not the cached list.
   */
  candidates?: RateEdition[],
): RateEdition {
  const list = candidates ?? editionsOnFile()
  if (candidates) {
    const problems = problemsWithList(candidates)
    if (problems.length > 0) {
      throw new PayrollError('BAD_TABLES', `The list of CRA editions is not usable: ${problems.join('; ')}.`)
    }
  } else {
    wellFormed()
  }
  const year = Number(payDate.slice(0, 4))
  // THE EDITION MUST BE OF THE PAY DATE'S OWN YEAR. Asking only whether the
  // year is covered and then walking backwards through the list lets the search
  // step over the year boundary: a 2027 with only a July edition on file would
  // hand a March 2027 pay date the 2026 July tables — BC at 6.14%, 2026's K
  // constants — and `vetted` would pass them, because there is nothing wrong
  // with those tables except the year they are for (independent critic,
  // 2026-09-12). This is the belt; `wellFormed` above is the braces.
  const found = [...list].reverse()
    .find((e) => payDate >= e.startsOn && Number(e.startsOn.slice(0, 4)) === year)
  if (!found) {
    throw new PayrollError('NO_TABLES',
      `Payroll has the CRA T4127 tables up to ${lastCoveredDate(list)} and no further; `
      + `${payDate} needs the ${year} tables, which are not on file. `
      + 'Add the edition under Payroll → The CRA numbers.')
  }
  return vetted(found)
}

/**
 * AND THE ARITHMETIC HAS TO HOLD BEFORE ANYTHING IS COMPUTED WITH IT.
 *
 * `rates-check.ts` re-derives what CRA's own numbers imply — the K constants,
 * the CPP and EI maximums, the BPAF spread. An edition that fails one of those
 * is not a table with a typo in it, it is a table that cannot be right, and a
 * payroll run on it would look entirely ordinary. So it does not run at all.
 *
 * A checker nothing calls is a checker, which is why this is here and not only
 * in the suite. Once per edition, since the answer cannot change at runtime.
 */
// KEYED ON THE OBJECT, not on its id. Keyed on the id, a second edition sharing
// an id was neither checked nor used: `vetted` returned the FIRST one's tables
// (independent critic, 2026-09-12).
const vetting = new WeakSet<RateEdition>()
export function vetted(e: RateEdition): RateEdition {
  if (vetting.has(e)) return e
  const { wrong } = problemsWith(e)
  if (wrong.length > 0) {
    throw new PayrollError('BAD_TABLES',
      `The ${e.id} tables do not add up and nothing will be computed from them: `
      + `${wrong.join('; ')}. See docs/design/35-the-cra-numbers.md.`)
  }
  vetting.add(e)
  return e
}

/**
 * AND THE LIST ITSELF, once, before any of it is used.
 *
 * `problemsWith` vets one edition; the rules about the LIST — in order, one id
 * each, a year's first edition starting on its first day, a year's editions
 * carrying the same CPP and EI — were checked only by the suite. They are the
 * more dangerous half: a well-formed edition filed in the wrong place computes
 * a real table for the wrong year (independent critic, 2026-09-12).
 */
// The version of the list last found well formed: adding editions in the app
// changes the list, so the answer is kept per version rather than once.
let listChecked = -1
export function wellFormed(): void {
  if (listChecked === addedVersion) return
  const problems = problemsWithList(editionsOnFile())
  if (problems.length > 0) {
    throw new PayrollError('BAD_TABLES',
      `The list of CRA editions is not usable: ${problems.join('; ')}. `
      + 'See docs/design/35-the-cra-numbers.md.')
  }
  listChecked = addedVersion
}

/** The CPP and EI numbers of a whole year — the T4 and the SR&ED cap want these. */
export function cppEiForYear(year: number): CppEiRates {
  wellFormed()
  const first = editionsOnFile().find((e) => Number(e.startsOn.slice(0, 4)) === year)
  if (!first) {
    throw new PayrollError('NO_TABLES',
      `Payroll knows ${coveredYears().join(', ') || 'no years'} and not ${year}. `
      + 'See docs/design/35-the-cra-numbers.md.')
  }
  return vetted(first).cppEi
}

