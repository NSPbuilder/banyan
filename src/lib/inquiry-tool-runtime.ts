import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { formatMoney } from './money'
import { resolvePeriodSpan } from './balances'
import { ours, NOT_OURS } from './ours'
import type { UserRecord } from './users'
import type { SkillId } from './assistant-skills'

export type ToolContext = {
  ledgerId: string
  entityId: string
  entityName: string
  user: UserRecord
  /** Present after the ERP router has selected one capability boundary. */
  skill?: SkillId
}

export type ToolSpec = { name: string; args: string; does: string }

export const RESULT_ROWS = 100

export const RESULT_CHARS = 12_000

export const choices = (list: readonly string[]): string => list.join('|')

export type Args = Record<string, unknown>

export class ArgError extends Error {}

export type Tool = ToolSpec & {
  order?: number
  /** The seat that opens this tool; for a tool whose seat depends on its arguments, the one these arguments need. */
  seats: (args: Args, ledgerId: string) => string[] | null
  /** The seats that put the tool on a person's list, when the seat a call needs depends on its arguments. */
  offeredTo?: string[]
  run: (ctx: ToolContext, args: Args, known: Set<bigint>) => Promise<string>
}

export const DATE = /^\d{4}-\d{2}-\d{2}$/

export const money = (c: bigint | string | number | null | undefined): string =>
  c === null || c === undefined || c === '' ? '' : formatMoney(BigInt(c), { sign: 'minus' })

export const text = (args: Args, key: string, required = true): string => {
  const v = args[key]
  if (v === undefined || v === null || v === '') {
    if (required) throw new ArgError(`"${key}" is needed.`)
    return ''
  }
  if (typeof v !== 'string' && typeof v !== 'number') throw new ArgError(`"${key}" must be text.`)
  return String(v).trim()
}

export const date = (args: Args, key: string, required = true): string => {
  const v = text(args, key, required)
  if (v && !DATE.test(v)) throw new ArgError(`"${key}" must be a date written YYYY-MM-DD.`)
  return v
}

export const oneOf = <T extends string>(args: Args, key: string, allowed: readonly T[], required = true): T | '' => {
  const v = text(args, key, required)
  if (v && !(allowed as readonly string[]).includes(v)) throw new ArgError(`"${key}" must be one of: ${allowed.join(', ')}.`)
  return v as T | ''
}

export const year = (args: Args): number => {
  const v = text(args, 'year')
  if (!/^\d{4}$/.test(v)) throw new ArgError('"year" must be four digits.')
  return Number(v)
}

export const cell = (v: string): string => v.replace(/\s*\n\s*/g, ' ').replace(/\|/g, '/')

export const tidy = (args: Args): Args =>
  Object.fromEntries(Object.entries(args).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]))

export function table(head: string[], columns: string[], rows: string[][], opts: { more?: boolean } = {}): string {
  const out = [...head, '', columns.join(' | ')]
  let size = out.join('\n').length
  let shown = 0
  for (const r of rows) {
    const line = r.map(cell).join(' | ')
    if (shown >= RESULT_ROWS || size + line.length + 1 > RESULT_CHARS - 200) break
    out.push(line)
    size += line.length + 1
    shown++
  }
  const left = rows.length - shown
  if (left > 0) out.push(`${left} more row${left === 1 ? '' : 's'} not shown${opts.more ? ', and more beyond those' : ''} — narrow the range, or use totals for sums.`)
  else if (opts.more) out.push('There are more rows than these — narrow the range.')
  if (rows.length === 0) out.push('(none)')
  return out.join('\n')
}

export const link = (ctx: ToolContext, path: string) => `/ledger/${ctx.ledgerId}${path}`

export async function mustBeOurs(kind: 'party' | 'employee', id: string, ledgerId: string): Promise<void> {
  if (!(await ours(kind, id, ledgerId))) throw new ArgError(NOT_OURS)
}

export async function span(ctx: ToolContext, args: Args) {
  const from = date(args, 'from')
  const to = date(args, 'to')
  if (from > to) throw new ArgError('"from" is after "to".')
  const s = await resolvePeriodSpan(ctx.ledgerId, from, to)
  if (!s) throw new ArgError('No accounting periods cover that range.')
  const said = s.snapped
    ? `Rounded to whole periods: ${s.fromPeriod.start_date} to ${s.toPeriod.end_date} (asked ${from} to ${to}).`
    : `From ${s.fromPeriod.start_date} to ${s.toPeriod.end_date}.`
  return { ...s, said }
}

export async function accountByCode(ctx: ToolContext, code: string) {
  const [a] = await db.execute<{ id: string; code: string; name: string }>(sql`
    SELECT id::text, code, name FROM account WHERE entity_id = ${ctx.entityId}::uuid AND code = ${code}`)
  if (!a) throw new ArgError('No account in this company has that code.')
  return a
}
