/**
 * What can be derived, re-derived — and refused if it disagrees.
 *
 * CRA publishes more numbers than it has to. Nearly every constant in T4127 is
 * a consequence of two or three others: the K constant of each bracket follows
 * from the brackets below it, the CPP maximums are the ceiling less the
 * exemption times the rate, the EI maximum premium is the MIE times the rate,
 * and the BPAF's reduction is its own spread over its own span. Checked against
 * all three editions on file, every one of those identities holds exactly.
 *
 * That is what makes a paste-in-the-numbers year safe: a mistyped digit almost
 * never satisfies the arithmetic, so it is caught here rather than by somebody
 * noticing a paycheque is three dollars out in March.
 *
 * PURE, and no floats — the same exact fractions the engine computes with.
 *
 * TWO KINDS OF PROBLEM, and the difference matters.
 *
 *  - `wrong` is definitional. An edition that has one of these is not a table
 *    with a typo, it is a table that cannot be right, and payroll refuses it.
 *  - `confirm` is empirical: an identity that holds on the editions we have and
 *    that CRA is under no obligation to preserve. A mid-year edition can break
 *    one legitimately, and one on file does — see `bcReduction` below. These are
 *    printed for a person to check against the PDF, never used to refuse.
 *
 * The `unconfirmed` idea is `sred_rate`'s and is used here for the same reason:
 * a hedge that stops the work is a hedge nobody keeps.
 */
import { asFrac, cmp, dollars, mul, rate, sub, type Frac } from './exact'
import type { BcRates, RateEdition, TaxRates } from './rates'

export type RateProblems = { wrong: string[]; confirm: string[] }

/** A cent difference, as a plain number, for a message. */
const gap = (a: Frac, b: Frac): string => {
  const d = sub(a, b)
  const cents = Number(d.num) / Number(d.den)
  return (cents / 100).toFixed(2)
}
const within = (a: Frac, b: Frac, cents: bigint) =>
  cmp(sub(a, b), asFrac(cents)) <= 0 && cmp(sub(b, a), asFrac(cents)) <= 0

/** Brackets: three arrays of one length, climbing, starting at nothing. */
function bracketShape(what: string, t: TaxRates, out: RateProblems) {
  const n = t.thresholds.length
  if (n === 0) { out.wrong.push(`${what}: no brackets at all`); return false }
  if (t.rates.length !== n || t.constants.length !== n) {
    out.wrong.push(`${what}: ${n} threshold(s) but ${t.rates.length} rate(s) and `
      + `${t.constants.length} constant(s) — a bracket is all three or it is none`)
    return false
  }
  if (t.thresholds[0] !== '0') out.wrong.push(`${what}: the first bracket starts at ${t.thresholds[0]}, not 0`)
  for (let i = 1; i < n; i++) {
    if (dollars(t.thresholds[i]!) <= dollars(t.thresholds[i - 1]!)) {
      out.wrong.push(`${what}: bracket ${i} starts at ${t.thresholds[i]}, not above ${t.thresholds[i - 1]}`)
    }
    // ASKED, NOT REFUSED. Nothing in T4127's formula needs the rates to climb
    // strictly — the K identity is well defined when two adjacent brackets share
    // a rate, and a split bracket at one rate would be refused on every pay run
    // for no reason (independent critic, 2026-09-12).
    if (cmp(rate(t.rates[i]!), rate(t.rates[i - 1]!)) < 0) {
      out.wrong.push(`${what}: bracket ${i} is taxed at ${t.rates[i]}, BELOW ${t.rates[i - 1]}`)
    } else if (cmp(rate(t.rates[i]!), rate(t.rates[i - 1]!)) === 0) {
      out.confirm.push(`${what}: brackets ${i - 1} and ${i} are both taxed at ${t.rates[i]}. `
        + 'That is arithmetically fine and unusual; check it is what the table says.')
    }
  }
  if (t.lowestRate !== t.rates[0]) {
    out.wrong.push(`${what}: lowestRate is ${t.lowestRate} and the first bracket is ${t.rates[0]}`)
  }
  return true
}

/**
 * K_i = K_(i-1) + threshold_i x (rate_i - rate_(i-1)), accumulated UNROUNDED
 * and rounded only at the end — which is how CRA's own table is built, and why
 * comparing each step against the published (rounded) constant would drift.
 * A dollar of tolerance; a mistyped digit is out by hundreds.
 */
function constantsFollow(what: string, t: TaxRates, out: RateProblems) {
  let acc: Frac = asFrac(0n)
  for (let i = 1; i < t.thresholds.length; i++) {
    const step = mul(asFrac(dollars(t.thresholds[i]!)),
                     sub(rate(t.rates[i]!), rate(t.rates[i - 1]!)))
    acc = { num: acc.num * step.den + step.num * acc.den, den: acc.den * step.den }
    const said = asFrac(dollars(t.constants[i]!))
    if (!within(acc, said, 100n)) {
      out.wrong.push(`${what}: bracket ${i}'s constant is ${t.constants[i]} and the brackets `
        + `make it ${gap(acc, asFrac(0n))} — out by ${gap(acc, said)}`)
    }
  }
}

/** BC's tax reduction: the credit is the span times the rate — usually. */
function bcReduction(what: string, id: string, bc: BcRates, out: RateProblems) {
  const r = bc.taxReduction
  const full = dollars(r.thresholdFull)
  const zero = dollars(r.thresholdZero)
  if (zero <= full) {
    out.wrong.push(`${what}: the reduction runs out at ${r.thresholdZero}, which is not above `
      + `${r.thresholdFull}`)
    return
  }
  const implied = mul(asFrac(zero - full), rate(r.reductionRate))
  // Confirmed for THIS edition only: a spread copy carries the numbers, not the reading.
  if (r.confirmed?.edition === id) return
  if (!within(implied, asFrac(dollars(r.maxCredit)), 100n)) {
    out.confirm.push(`${what}: the reduction phases out over ${r.thresholdFull}–${r.thresholdZero} `
      + `at ${r.reductionRate}, which spends ${gap(implied, asFrac(0n))} — but the credit on file `
      + `is ${r.maxCredit}. On a mid-year edition that can be right: a true-up raises the credit `
      + 'without moving the endpoints. Check T4127 Table 8.2 for this edition.')
  }
}

/** Everything wrong with one edition, and everything worth a second look. */
export function problemsWith(e: RateEdition): RateProblems {
  const out: RateProblems = { wrong: [], confirm: [] }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.startsOn)) {
    out.wrong.push(`${e.id}: "${e.startsOn}" is not a date this can order editions by`)
  }
  if (!e.authority.trim()) out.wrong.push(`${e.id}: no authority — which T4127 edition is this?`)
  // The id is how the page names the edition; a 2027 id on a 2026 table would
  // sit on the payroll page claiming a year it does not cover.
  if (e.id.slice(0, 4) !== e.startsOn.slice(0, 4)) {
    out.wrong.push(`${e.id} is named for ${e.id.slice(0, 4)} but starts on ${e.startsOn}`)
  }

  if (bracketShape(`${e.id} federal`, e.federal, out)) constantsFollow(`${e.id} federal`, e.federal, out)
  if (bracketShape(`${e.id} BC`, e.bc, out)) constantsFollow(`${e.id} BC`, e.bc, out)

  const c = e.cppEi.cpp
  const contributory = dollars(c.ympe) - dollars(c.basicExemption)
  const derived: Array<[string, Frac, string]> = [
    ['the CPP maximum', mul(asFrac(contributory), rate(c.rate)), c.maxContribution],
    ['the CPP base maximum', mul(asFrac(contributory), rate(c.baseRate)), c.maxBaseContribution],
    ['the CPP2 maximum', mul(asFrac(dollars(c.yampe) - dollars(c.ympe)), rate(c.cpp2Rate)),
     c.maxCpp2Contribution],
    ['the EI maximum premium', mul(asFrac(dollars(e.cppEi.ei.mie)), rate(e.cppEi.ei.rate)),
     e.cppEi.ei.maxPremium],
  ]
  for (const [what, made, said] of derived) {
    // A CENT of tolerance, not none. The products land exactly today because
    // the ceilings are multiples of a hundred and the rates carry four
    // decimals; a five-decimal rate would put them under a cent and hard-refuse
    // a correct table. A transcription error is out by dollars
    // (independent critic, 2026-09-12).
    if (!within(made, asFrac(dollars(said)), 1n)) {
      out.wrong.push(`${e.id}: ${what} on file is ${said}, and the figures it comes from `
        + `make it ${gap(made, asFrac(0n))}`)
    }
  }
  if (cmp(rate(c.rate), sub(rate(c.baseRate), { num: -rate(c.firstAdditionalRate).num,
                                                den: rate(c.firstAdditionalRate).den })) !== 0) {
    out.wrong.push(`${e.id}: the CPP rate ${c.rate} is not ${c.baseRate} plus `
      + `${c.firstAdditionalRate}`)
  }
  if (dollars(c.ympe) >= dollars(c.yampe)) {
    out.wrong.push(`${e.id}: the YMPE ${c.ympe} is not below the YAMPE ${c.yampe}`)
  }

  const b = e.federal.bpaf
  if (dollars(b.min) >= dollars(b.max)) {
    out.wrong.push(`${e.id}: the BPAF floor ${b.min} is not below its ceiling ${b.max}`)
  }
  if (dollars(b.niLower) >= dollars(b.niUpper)) {
    out.wrong.push(`${e.id}: the BPAF phase-out starts at ${b.niLower} and ends at ${b.niUpper}`)
  }
  if (dollars(b.reductionNumerator) !== dollars(b.max) - dollars(b.min)) {
    out.wrong.push(`${e.id}: the BPAF reduction numerator is ${b.reductionNumerator} and the `
      + `spread between ${b.min} and ${b.max} is not that`)
  }
  if (dollars(b.reductionDenominator) !== dollars(b.niUpper) - dollars(b.niLower)) {
    out.wrong.push(`${e.id}: the BPAF reduction denominator is ${b.reductionDenominator} and the `
      + `span between ${b.niLower} and ${b.niUpper} is not that`)
  }

  bcReduction(`${e.id} BC`, e.id, e.bc, out)
  return out
}

/** The list as a whole: in order, named once each, and no gap before a year. */
/**
 * Numbers as text with the keys in one order. `JSON.stringify` alone follows
 * insertion order, and Postgres `jsonb` hands keys back sorted its own way — so
 * an edition read from the database and the same numbers typed into the form
 * would look different, and a second edition in a year the app added would be
 * refused for carrying "different" CPP/EI (PR60 found it).
 */
const byValue = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) =>
  x && typeof x === 'object' && !Array.isArray(x)
    ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : x)

/** Whether two editions carry the same numbers, whatever order their keys arrived in. */
export const sameFigures = (a: RateEdition, b: RateEdition): boolean =>
  byValue([a.cppEi, a.federal, a.bc]) === byValue([b.cppEi, b.federal, b.bc])

export function problemsWithList(editions: RateEdition[]): string[] {
  const sameYear = (a: RateEdition, b: RateEdition) =>
    a.startsOn.slice(0, 4) === b.startsOn.slice(0, 4)
  const out: string[] = []
  editions.forEach((e, i) => {
    const before = editions[i - 1]
    if (before && e.startsOn <= before.startsOn) {
      out.push(`${e.id} starts on ${e.startsOn}, which is not after ${before.id}'s ${before.startsOn}`)
    }
    if (editions.some((o, j) => j !== i && o.id === e.id)) out.push(`two editions are called ${e.id}`)
    // A year is entered at its first day or not at all: an edition starting in
    // March would leave January and February computing on last year's tables.
    const first = editions.find((o) => o.startsOn.slice(0, 4) === e.startsOn.slice(0, 4))
    if (first === e && !e.startsOn.endsWith('-01-01')) {
      out.push(`${e.id} is the first edition of ${e.startsOn.slice(0, 4)} and starts on `
        + `${e.startsOn}, so nothing covers the start of that year`)
    }
    // AND A YEAR'S EDITIONS CARRY ONE SET OF CPP AND EI. `cppEiForYear` — which
    // the T4 boxes and the SR&ED cap both read — takes the year's FIRST edition,
    // so if a mid-year edition ever moved a ceiling the slips and the stubs
    // would disagree, which is the second-copy failure sred.ts says it exists to
    // avoid (independent critic, 2026-09-12).
    // By VALUE: an edition added in the app is read back from the database as a
    // fresh object, and one carrying the year's very numbers is the right one.
    if (before && sameYear(before, e) && byValue(before.cppEi) !== byValue(e.cppEi)) {
      out.push(`${before.id} and ${e.id} are the same year and carry different CPP/EI numbers; `
        + '`cppEiForYear` reads only the first, so the T4 and the stubs would disagree')
    }
  })
  return out
}
