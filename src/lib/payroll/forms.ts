import 'server-only'
import {
  moneyFrom,
  g,
  PAYROLL_FIELDS as F, payBonus, payEmployee, payGross, payHours, payIndicesIn, payInsurable,
  payPensionable,
} from '../forms'
import { PayrollError } from './rates'
import { deleteEmployee, fullMessage, saveEmployee } from './employees'
import { refuseUnlessOurs } from '../ours'
import { runPayroll, type PayLine } from './runs'

/**
 * Reading the payroll forms. Separate from `app/actions.ts` for the reason
 * every other *-forms.ts is: a check can call this and cannot call a server
 * action.
 */

export type FormResult = { ok?: string; error?: string; runId?: string; entryId?: string }


/** Cents, or the refusal that names what would not read. */
const money = (raw: string, what: string) => moneyFrom(raw, what, (m) => new PayrollError('BAD_AMOUNT', m))

/** An optional amount: blank means "not given", which is not the same as zero. */
const optionalMoney = (raw: string, what: string): bigint | undefined =>
  raw ? money(raw, what) : undefined

/**
 * Hours as hundredths: "37.5" is 3750n. `parseMoney` already turns a decimal
 * string into hundredths and refuses what is not one, and hours are kept in
 * hundredths for the same reason money is kept in cents — so this is the same
 * question, asked once (0052).
 */
const optionalHours = (raw: string): bigint | undefined =>
  raw ? money(raw, 'a number of hours') : undefined

/** Somebody put on the payroll by mistake, taken off it — only while never paid (0084). */
export async function deleteEmployeeFromForm(f: FormData, actor: string): Promise<FormResult> {
  const ledgerId = g(f, F.ledgerId)
  const employeeId = g(f, F.employeeId)
  const nope = await refuseUnlessOurs([['employee', employeeId]], ledgerId)
  if (nope) return nope
  try {
    const gone = await deleteEmployee(ledgerId, employeeId, actor)
    return { ok: `${gone.name} is off the payroll. They stay on the company's list.` }
  } catch (e) {
    if (e instanceof PayrollError) return { error: e.message }
    throw e
  }
}

export async function saveEmployeeFromForm(f: FormData, actor: string): Promise<FormResult> {
  try {
    const ledgerId = g(f, F.ledgerId)
    const partyId = g(f, F.partyId)
    if (!partyId) throw new PayrollError('NO_PARTY', 'Who is being paid?')
    const frequency = g(f, F.frequency)
    if (!frequency) throw new PayrollError('NO_FREQUENCY', 'How often are they paid?')

    await saveEmployee({
      ledgerId,
      id: g(f, F.employeeId) || undefined,
      partyId,
      frequency,
      // Blank is claim code 1 — the basic amount the engine works out for the
      // edition. Zero is a real answer meaning "no claim", and they must not
      // read as the same thing.
      federalClaim: optionalMoney(g(f, F.federalClaim), 'a federal TD1 claim') ?? null,
      bcClaim: optionalMoney(g(f, F.bcClaim), 'a BC TD1 claim') ?? null,
      occupation: g(f, F.occupation) || null,
      additionalTax: optionalMoney(g(f, F.additionalTax), 'additional tax'),
      sin: g(f, F.sin) || null,
      hiredOn: g(f, F.hiredOn) || null,
      // An unchecked box sends nothing at all, so its absence is the answer.
      isActive: f.get(F.isActive) !== null,
      // The same reading, and the reason this one matters: ticked, the SR&ED
      // 5 x YMPE cap applies to this person's year.
      isSpecified: f.get(F.isSpecified) !== null,
      cppExempt: f.get(F.cppExempt) !== null,
      eiExempt: f.get(F.eiExempt) !== null,
      actor,
    })
    return { ok: 'Saved.' }
  } catch (e) {
    return { error: said(e) }
  }
}

export async function runPayrollFromForm(f: FormData, actor: string): Promise<FormResult> {
  try {
    const ledgerId = g(f, F.ledgerId)
    const payDate = g(f, F.payDate)
    if (!payDate) throw new PayrollError('NO_DATE', 'What day does the money move?')
    const bankAccountId = g(f, F.bankAccountId)
    if (!bankAccountId) throw new PayrollError('NO_BANK', 'Which account does the pay come out of?')

    // The rows that arrived, not a count either side has an opinion about.
    // A row nobody typed anything into is an unused extra. A row with ANYTHING
    // in it is a row: somebody entered it, and dropping it silently is how a
    // payday comes up short with every figure on it agreeing. Hours count as
    // something typed — they used to be read only alongside a name and an
    // amount, so hours entered on their own vanished (critic).
    const lines: PayLine[] = []
    for (const i of payIndicesIn([...f.keys()])) {
      const employeeId = g(f, payEmployee(i))
      const gross = g(f, payGross(i))
      const typed = [gross, g(f, payHours(i)), g(f, payPensionable(i)), g(f, payInsurable(i)),
                     g(f, payBonus(i))].some(Boolean)
      if (!employeeId && !typed) continue
      if (!employeeId) throw new PayrollError('NO_EMPLOYEE', `Row ${i + 1} has pay but nobody to pay.`)
      if (!gross) throw new PayrollError('NO_GROSS', `Row ${i + 1} names somebody but no amount.`)
      lines.push({
        employeeId,
        gross: money(gross, 'an amount'),
        pensionable: optionalMoney(g(f, payPensionable(i)), 'pensionable earnings'),
        insurable: optionalMoney(g(f, payInsurable(i)), 'insurable earnings'),
        hours: optionalHours(g(f, payHours(i))),
        bonus: optionalMoney(g(f, payBonus(i)), 'a bonus'),
      })
    }
    if (lines.length === 0) {
      throw new PayrollError('NOBODY', 'Nobody is on this run. Add at least one person.')
    }

    const run = await runPayroll({
      ledgerId,
      payDate,
      periodStart: g(f, F.periodStart) || undefined,
      periodEnd: g(f, F.periodEnd) || undefined,
      bankAccountId,
      lines,
      actor,
      idempotencyKey: g(f, F.idempotencyKey) || undefined,
    })
    return {
      ok: run.replayed
        ? `Already run — entry ${run.entryNo}.`
        : `Posted as ${run.entryNo}.`,
      runId: run.runId,
      entryId: run.entryId,
    }
  } catch (e) {
    return { error: said(e) }
  }
}

/**
 * What to show somebody. A `PayrollError` was written for them; anything else
 * was not, and saying "something went wrong" hides which payday failed — so
 * the message comes through either way.
 *
 * The fallback reads the whole cause chain, not `.message`: under this driver
 * `.message` on a failed statement is always "Failed query: INSERT INTO …" and
 * the refusal that matters is one or two levels down. Reading only the top is
 * the same bug `translate` was repaired for, one layer up (critic).
 */
function said(e: unknown): string {
  if (e instanceof PayrollError) return e.message
  return fullMessage(e)
}
