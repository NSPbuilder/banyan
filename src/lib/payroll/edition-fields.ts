/**
 * EVERY FIGURE A T4127 EDITION CARRIES — one list, read three ways.
 *
 * The owner could not see the CRA numbers anywhere in the app, and had no way
 * to give it a new edition (2026-09-16: 「payroll 的 T4127 具体数据我在 app 里
 * 看不到，如果有新的 t4127 了，我如何告诉 app」). This is the list both answers
 * are built from:
 *
 *   the payroll screen   shows every figure of every edition, grouped by the
 *                        T4127 table it is read off;
 *   the add form         asks for every figure, in this order, opened on the
 *                        last edition's numbers so only what moved is typed;
 *   the door             reads the same names back into a `RateEdition`.
 *
 * A figure added here is one the screen shows, the form asks for and the door
 * reads, the same day. Which T4127 table each is on is design doc 35's table,
 * said here once per field.
 *
 * Client-safe: the form and the screen render it, and checks read it.
 */
import type { RateEdition } from './rates'

export type FigureKind = 'money' | 'rate' | 'list' | 'number'

export type Figure = {
  /** The path inside a `RateEdition`, dotted — also the form field's name. */
  path: string
  label: string
  /** The T4127 table it is read off. */
  table: string
  kind: FigureKind
}

export type FigureGroup = { title: string; figures: Figure[] }

export const EDITION_FIGURES: FigureGroup[] = [
  {
    title: 'CPP',
    figures: [
      { path: 'cppEi.cpp.ympe', label: 'YMPE', table: '8.3', kind: 'money' },
      { path: 'cppEi.cpp.yampe', label: 'YAMPE', table: '8.3', kind: 'money' },
      { path: 'cppEi.cpp.basicExemption', label: 'Basic exemption', table: '8.3', kind: 'money' },
      { path: 'cppEi.cpp.rate', label: 'Rate', table: '8.3', kind: 'rate' },
      { path: 'cppEi.cpp.maxContribution', label: 'Maximum contribution', table: '8.3', kind: 'money' },
      { path: 'cppEi.cpp.baseRate', label: 'Base rate', table: '8.4', kind: 'rate' },
      { path: 'cppEi.cpp.maxBaseContribution', label: 'Maximum base contribution', table: '8.4', kind: 'money' },
      { path: 'cppEi.cpp.firstAdditionalRate', label: 'First additional rate', table: '8.4', kind: 'rate' },
      { path: 'cppEi.cpp.cpp2Rate', label: 'CPP2 rate', table: '8.5', kind: 'rate' },
      { path: 'cppEi.cpp.maxCpp2Contribution', label: 'Maximum CPP2 contribution', table: '8.5', kind: 'money' },
    ],
  },
  {
    title: 'EI',
    figures: [
      { path: 'cppEi.ei.mie', label: 'Maximum insurable earnings', table: '8.6', kind: 'money' },
      { path: 'cppEi.ei.rate', label: 'Rate', table: '8.6', kind: 'rate' },
      { path: 'cppEi.ei.maxPremium', label: 'Maximum premium', table: '8.6', kind: 'money' },
      { path: 'cppEi.ei.employerMultiplier', label: 'Employer multiple', table: '8.7', kind: 'number' },
    ],
  },
  {
    title: 'Federal tax',
    figures: [
      { path: 'federal.thresholds', label: 'Bracket floors (A)', table: '8.1', kind: 'list' },
      { path: 'federal.rates', label: 'Rates (R)', table: '8.1', kind: 'list' },
      { path: 'federal.constants', label: 'Constants (K)', table: '8.1', kind: 'list' },
      { path: 'federal.lowestRate', label: 'Lowest rate', table: '8.1', kind: 'rate' },
      { path: 'federal.bpaf.max', label: 'BPAF maximum', table: '8.2', kind: 'money' },
      { path: 'federal.bpaf.min', label: 'BPAF minimum', table: '8.2', kind: 'money' },
      { path: 'federal.bpaf.niLower', label: 'BPAF phase-out starts', table: '8.2', kind: 'money' },
      { path: 'federal.bpaf.niUpper', label: 'BPAF phase-out ends', table: '8.2', kind: 'money' },
      { path: 'federal.bpaf.reductionNumerator', label: 'BPAF reduction numerator', table: '8.2', kind: 'money' },
      { path: 'federal.bpaf.reductionDenominator', label: 'BPAF reduction denominator', table: '8.2', kind: 'money' },
      { path: 'federal.cea', label: 'Canada employment amount', table: '8.2', kind: 'money' },
    ],
  },
  {
    title: 'British Columbia tax',
    figures: [
      { path: 'bc.thresholds', label: 'Bracket floors (A)', table: '8.1', kind: 'list' },
      { path: 'bc.rates', label: 'Rates (V)', table: '8.1', kind: 'list' },
      { path: 'bc.constants', label: 'Constants (KP)', table: '8.1', kind: 'list' },
      { path: 'bc.lowestRate', label: 'Lowest rate', table: '8.1', kind: 'rate' },
      { path: 'bc.basicPersonalAmount', label: 'Basic personal amount', table: '8.2', kind: 'money' },
      { path: 'bc.taxReduction.maxCredit', label: 'Tax reduction (S2) maximum', table: '8.2', kind: 'money' },
      { path: 'bc.taxReduction.thresholdFull', label: 'Tax reduction full up to', table: '8.2', kind: 'money' },
      { path: 'bc.taxReduction.thresholdZero', label: 'Tax reduction gone at', table: '8.2', kind: 'money' },
      { path: 'bc.taxReduction.reductionRate', label: 'Tax reduction rate', table: '8.2', kind: 'rate' },
    ],
  },
]

export const ALL_FIGURES: Figure[] = EDITION_FIGURES.flatMap((g) => g.figures)

/** The add form's other names: when the edition starts and what it is, and the PDOC example (0082). */
export const EDITION_HEAD = { startsOn: 'startsOn', authority: 'authority', editionId: 'editionId' } as const

export const PDOC_FIELDS = {
  payDate: 'pdoc.payDate', frequency: 'pdoc.frequency', gross: 'pdoc.gross',
  federalClaim: 'pdoc.federalClaim', bcClaim: 'pdoc.bcClaim',
  cpp: 'pdoc.cpp', cpp2: 'pdoc.cpp2', ei: 'pdoc.ei', federalTax: 'pdoc.federalTax', provincialTax: 'pdoc.provincialTax',
} as const

/** A figure's value in an edition, as the tables write it — a list joined with ", ". */
export function figureOf(e: RateEdition, path: string): string {
  let at: unknown = e
  for (const part of path.split('.')) at = (at as Record<string, unknown> | undefined)?.[part]
  return Array.isArray(at) ? at.join(', ') : typeof at === 'string' ? at : ''
}

const SHAPE: Record<FigureKind, RegExp> = {
  money: /^\d+(\.\d{1,2})?$/,
  rate: /^\d*\.\d+$|^\d+$/,
  number: /^\d+(\.\d+)?$/,
  list: /^\d+(\.\d+)?$/,
}

/**
 * The figures a form sent, as an edition — or every figure that is not a
 * number, named, so the whole form is fixed in one pass. Commas and dollar
 * signs are forgiven in money (people copy them off the PDF); a list is split
 * on commas. Nothing here checks that the numbers AGREE — that is
 * `rates-check.ts`, which the door asks next.
 */
export function editionFromFigures(
  head: { id: string; startsOn: string; authority: string },
  read: (path: string) => string,
): { edition: RateEdition | null; problems: string[] } {
  const problems: string[] = []
  const out: Record<string, unknown> = { id: head.id, startsOn: head.startsOn, authority: head.authority }
  for (const f of ALL_FIGURES) {
    const raw = read(f.path).trim()
    let value: string | string[]
    if (f.kind === 'list') {
      value = raw.split(',').map((x) => x.trim().replace(/[$\s]/g, '')).filter((x) => x !== '')
      if (value.length === 0 || value.some((x) => !SHAPE.list.test(x))) {
        problems.push(`${f.label} (table ${f.table}) is not a list of numbers separated by commas`)
      }
    } else {
      value = f.kind === 'money' ? raw.replace(/[$,\s]/g, '') : raw
      if (!SHAPE[f.kind].test(value)) problems.push(`${f.label} (table ${f.table}) "${raw}" is not a number`)
    }
    const parts = f.path.split('.')
    let at = out
    for (const part of parts.slice(0, -1)) at = (at[part] ??= {}) as Record<string, unknown>
    at[parts[parts.length - 1]] = value
  }
  return { edition: problems.length === 0 ? (out as unknown as RateEdition) : null, problems }
}
