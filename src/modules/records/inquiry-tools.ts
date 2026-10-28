import 'server-only'
import { date, oneOf, table, choices, ArgError, type Tool } from '@/lib/inquiry-tool-runtime'
import { localToday } from '@/lib/today'
import { REGISTER_KINDS, renderRegisterForLedger, type RegisterKind } from '@/lib/registers'

export const inquiryTools: Tool[] = [
{
    order: 20,
    name: 'register', args: `{kind: ${choices(REGISTER_KINDS)}, as_of?}`, does: 'a statutory register as at a date: directors, securities holders and transfers, or significant individuals',
    seats: () => ['/records'],
    run: async (ctx, args) => {
      const kind = oneOf(args, 'kind', REGISTER_KINDS) as RegisterKind
      const asOf = date(args, 'as_of', false) || localToday()
      const rendered = await renderRegisterForLedger(kind, ctx.ledgerId, asOf, 'director')
      if (!rendered) throw new ArgError('That register could not be read for this company.')
      const r = rendered.register
      const main = table([`${r.title} as at ${r.asOf} — ${r.entityName}`, ...r.headerNotes], r.columns, r.rows)
      return r.detail ? `${main}\n\n${table([r.detail.title], r.detail.columns, r.detail.rows)}` : main
    },
  },
]
