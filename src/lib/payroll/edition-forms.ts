import 'server-only'
import { type FormResult, g, sentenceOf } from '../forms'
import { parseMoney } from '../money'
import { FREQUENCIES, type Frequency } from './engine'
import { EDITION_HEAD, PDOC_FIELDS, editionFromFigures } from './edition-fields'
import { addEdition, removeEdition, type PdocCase } from './editions'
import { PayrollError, lastCoveredDate } from './rates'

/**
 * Reading the "add an edition" form (0082). Separate from `app/actions.ts` for
 * the reason every *-forms.ts is: a check can call this and cannot call a
 * server action. Every name it reads — the figures' paths, the head, the PDOC
 * example's — is `edition-fields.ts`'s, which the client form speaks too.
 */

const cents = (typed: string): string | null => {
  if (!/^\$?\s*[\d,]+(\.\d{1,2})?$/.test(typed.trim())) return null
  return parseMoney(typed).toString()
}

export async function addEditionFromForm(f: FormData, actor: string): Promise<FormResult> {
  const startsOn = g(f, EDITION_HEAD.startsOn)
  const authority = g(f, EDITION_HEAD.authority)
  const problems: string[] = []
  if (!/^\d{4}-\d{2}-01$/.test(startsOn)) problems.push('the edition starts on the first of a month')
  if (!authority) problems.push('say which T4127 edition this is, and what moved in it')
  const { edition, problems: figureProblems } = editionFromFigures(
    { id: startsOn.slice(0, 7), startsOn, authority }, (path) => g(f, path))
  problems.push(...figureProblems)

  const frequency = g(f, PDOC_FIELDS.frequency)
  if (!(frequency in FREQUENCIES)) problems.push('say how often the PDOC example is paid')
  const payDate = g(f, PDOC_FIELDS.payDate)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(payDate)) problems.push('the PDOC example needs its pay date')
  const money: Record<string, string | null> = {}
  for (const [key, label] of [
    ['gross', 'gross pay'], ['federalClaim', 'federal claim'], ['bcClaim', 'BC claim'],
    ['cpp', 'CPP'], ['cpp2', 'CPP2'], ['ei', 'EI'], ['federalTax', 'federal tax'], ['provincialTax', 'BC tax'],
  ] as const) {
    money[key] = cents(g(f, PDOC_FIELDS[key]))
    if (money[key] === null) problems.push(`the PDOC ${label} "${g(f, PDOC_FIELDS[key])}" is not an amount`)
  }
  if (problems.length > 0 || !edition) {
    return { error: `Nothing was saved. ${problems.join('; ')}.` }
  }
  const pdoc: PdocCase = {
    payDate, frequency: frequency as Frequency,
    gross: money.gross!, federalClaim: money.federalClaim!, bcClaim: money.bcClaim!,
    expect: {
      cpp: money.cpp!, cpp2: money.cpp2!, ei: money.ei!,
      federalTax: money.federalTax!, provincialTax: money.provincialTax!,
    },
  }
  try {
    await addEdition({ edition, pdoc, actor })
    return { ok: `Added ${edition.id}. Its figures agree with each other and the PDOC example matched to the cent; `
      + `payroll can now run up to ${lastCoveredDate()}.` }
  } catch (e) {
    return { error: sentenceOf(e, PayrollError) }
  }
}

export async function removeEditionFromForm(f: FormData, actor: string): Promise<FormResult> {
  const id = g(f, EDITION_HEAD.editionId)
  try {
    await removeEdition(id, actor)
    return { ok: `Removed ${id}. Payroll can now run up to ${lastCoveredDate()}.` }
  } catch (e) {
    return { error: sentenceOf(e, PayrollError) }
  }
}
