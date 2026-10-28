import 'server-only'
import { money, text, date, year, table, link, mustBeOurs, type Tool } from '@/lib/inquiry-tool-runtime'
import { listEmployees, stubsFor } from '@/lib/payroll/employees'
import { payRuns, remittanceMonths } from '@/lib/payroll/runs'
import { t4Year } from '@/lib/payroll/t4'
const T4_BOXES = new Set(['14', '16', '16A', '17', '18', '20', '22', '24', '26', '28', '40', '44', '45'])

export const inquiryTools: Tool[] = [
{
    order: 15,
    name: 'employees', args: '{}', does: 'the people on the payroll: pay frequency, tax claims, occupation, hire date, whether still employed, exemptions',
    seats: () => ['/payroll'],
    run: async (ctx) => {
      const rows = await listEmployees(ctx.ledgerId)
      return table(
        [`Employees — ${ctx.entityName}`, 'Use the id in a link as "employee" for pay_stubs.'],
        ['name', 'frequency', 'federal claim', 'BC claim', 'extra tax', 'occupation', 'hired', 'employed', 'CPP exempt', 'EI exempt', 'link'],
        rows.map((e) => [e.party_name, e.frequency, money(e.federal_claim), money(e.bc_claim), money(e.additional_tax),
          e.occupation ?? '', e.hired_on ?? '', e.is_active ? 'yes' : 'no', e.cpp_exempt ? 'yes' : 'no', e.ei_exempt ? 'yes' : 'no',
          link(ctx, `/payroll/people/${e.id}`)]))
    },
  },
{
    order: 16,
    name: 'pay_runs', args: '{from?, to?}', does: 'every pay run still in the books: pay date, people, gross, net, deductions and the employer\'s share',
    seats: () => ['/payroll'],
    run: async (ctx, args) => {
      const from = date(args, 'from', false)
      const to = date(args, 'to', false)
      const rows = (await payRuns(ctx.ledgerId))
        .filter((r) => r.status === 'posted' && (!from || r.pay_date >= from) && (!to || r.pay_date <= to))
      return table(
        [`Pay runs — ${ctx.entityName}`, 'A run whose entry was reversed was not pay and is left out, as the T4 and the remittances leave it out.'],
        ['pay date', 'period', 'people', 'gross', 'net', 'CPP', 'CPP2', 'EI', 'income tax', 'employer CPP', 'employer CPP2', 'employer EI', 'entry', 'link'],
        rows.map((r) => [r.pay_date, r.period_start && r.period_end ? `${r.period_start} to ${r.period_end}` : '', r.people,
          money(r.gross), money(r.net_pay), money(r.cpp), money(r.cpp2), money(r.ei), money(r.income_tax),
          money(r.employer_cpp), money(r.employer_cpp2), money(r.employer_ei), r.entry_no ?? '', link(ctx, `/payroll/runs/${r.id}`)]))
    },
  },
{
    order: 17,
    name: 'pay_stubs', args: '{employee: id, year}', does: 'one person\'s pay stubs for a year',
    seats: () => ['/payroll'],
    run: async (ctx, args) => {
      const employee = text(args, 'employee')
      await mustBeOurs('employee', employee, ctx.ledgerId)
      const y = year(args)
      const rows = (await stubsFor(ctx.ledgerId, employee, y)).filter((s) => s.status === 'posted')
      const gross = rows.reduce((t, s) => t + BigInt(s.gross), 0n)
      return table(
        [`Pay stubs for ${y} — ${ctx.entityName}`, 'Stubs of reversed runs are left out.', `Gross for the year: ${money(gross)}.`],
        ['pay date', 'gross', 'CPP', 'CPP2', 'EI', 'federal tax', 'BC tax', 'extra tax', 'net', 'employer CPP', 'employer CPP2', 'employer EI', 'entry'],
        rows.map((s) => [s.pay_date, money(s.gross), money(s.cpp), money(s.cpp2), money(s.ei), money(s.federal_tax),
          money(s.provincial_tax), money(s.additional_tax), money(s.net_pay), money(s.employer_cpp), money(s.employer_cpp2),
          money(s.employer_ei), s.entry_no ?? '']))
    },
  },
{
    order: 18,
    name: 'remittances', args: '{year}', does: 'what was due to CRA each month of a year for source deductions',
    seats: () => ['/payroll'],
    run: async (ctx, args) => {
      const y = year(args)
      const rows = await remittanceMonths(ctx.ledgerId, y)
      return table(
        [`Source deduction remittances for ${y} — ${ctx.entityName}`, 'CPP and EI include both shares.'],
        ['month', 'due', 'runs', 'people', 'gross', 'CPP', 'EI', 'income tax', 'total'],
        rows.map((m) => [m.month, m.dueOn, String(m.runs), String(m.employees), money(m.gross), money(m.cpp), money(m.ei),
          money(m.incomeTax), money(m.total)]))
    },
  },
{
    order: 19,
    name: 't4', args: '{year}', does: 'the T4 figures for a year, person by person, with the summary totals',
    seats: () => ['/payroll'],
    run: async (ctx, args) => {
      const y = year(args)
      const t = await t4Year(ctx.ledgerId, y)
      return table(
        [`T4 figures for ${y} — ${t.employer.name}`,
         `Employer: ${t.employer.legalName ?? t.employer.name}; business number ${t.employer.businessNumber ?? 'none'}; province ${t.employer.province ?? 'unknown'}.`,
         `Totals: box 14 ${money(t.totals.box14)}, box 16 ${money(t.totals.box16)}, box 16A ${money(t.totals.box16a)}, box 18 ${money(t.totals.box18)}, box 22 ${money(t.totals.box22)}.`,
         ...t.caveats],
        ['person', 'boxes'],
        t.employees.map((e) => [e.name, e.empty ? 'nothing paid this year'
          : e.boxes.filter((b) => T4_BOXES.has(b.box)).map((b) => `${b.box} ${b.label}: ${b.amount !== null ? money(b.amount) : b.text ?? b.absent ?? ''}`).join('; ')]))
    },
  },
]
