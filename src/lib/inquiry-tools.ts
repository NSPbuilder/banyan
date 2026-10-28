import { moduleInquiryTools } from './module-extensions'
import { RESULT_ROWS, money, text, date, oneOf, table, link, mustBeOurs, choices, ArgError, span, accountByCode, tidy, type Tool, type Args, type ToolContext, type ToolSpec } from './inquiry-tool-runtime'
export { RESULT_ROWS, RESULT_CHARS, type ToolContext, type ToolSpec } from './inquiry-tool-runtime'
import 'server-only'
import { formatNative, nativeInput } from './fx-money'
import { sql } from 'drizzle-orm'
import { invoicePath } from '@/lib/invoice-routes'
import { db } from '@/db/client'
import { refuseForLedger } from './access'
import { seatsForPath } from './nav'
import { NOT_OURS } from './ours'
import { localToday } from './today'
import { search } from './search'
import { readQuery } from './query'
import { DEFAULT_BALANCE, chartOfAccounts } from './accounts'
import { partiesFor } from './parties'
import { trialBalanceSpan } from './balances'
import { driftProblem } from './drift'
import { generalLedger, journalEntries } from './reports'
import { renderStatement } from './statements'
import { renderCashFlow } from './cash-flow'
import { renderEquityChanges } from './equity-changes'
import { BUCKETS, aging } from './aging'
import { openItemsFor, owedAmount } from './payments'
import { partyLedger } from './browse'
import { BANK_ROW_STATES, accountInLedger, accountStandings, bankRows } from './bank'
import { gstHstReturn, pstReturn } from './tax'
import { REPORTS, STATEMENT_KEYS, TAX_RETURN_KEYS, isReportKey, reportLink } from './report-catalogue'
import {
  moduleDestination, skillById, toolNamesForSkill, type SkillId,
} from './assistant-skills'
/** `search`'s own limit, per kind of thing it finds. */
const SEARCH_PER_KIND = 25

/**
 * THE CLOSED OPTION LISTS, each declared ONCE.
 *
 * Every one of these used to be written twice — into the `args` prose the
 * model reads, and again into the `oneOf` beside it that decides what is
 * accepted. Nine of them (owner, 2026-09-16: 「尽量不要用硬编码」). They agreed
 * on the day they were checked, which is the most that can ever be said of two
 * copies: the failure is silent in both directions, because a model told a
 * list it cannot use gets a refusal it cannot understand, and a capability
 * left out of the prose is one nobody discovers.
 *
 * So: one list, interpolated into the prose and passed to the validator. Four
 * of them are not declared here at all but DERIVED from where the fact already
 * lives — the statements and the tax returns from the report catalogue, the
 * registers and the bank states from the modules that own them. `IQ-options`
 * refuses any `args` string that still spells a list out.
 */
const ACCOUNT_TYPES = Object.keys(DEFAULT_BALANCE)
const GROUP_BY = ['account', 'party', 'month'] as const
const SIDES = ['receivable', 'payable'] as const
const INVOICE_DIRECTIONS = ['sales', 'purchase'] as const
/** Which way money went for ONE party — not an invoice's direction, despite the shared word. */
const PARTY_FLOW = ['out', 'in'] as const
const CALC_OPS = ['sum', 'difference'] as const

// -------------------------------------------------------------------- tools --

const TOOLS: Tool[] = [
{
    order: 0,
    name: 'calendar', args: '{}', does: "today's date, and every fiscal year and period with its dates and status",
    seats: () => ['/assistant'],
    run: async (ctx) => {
      const years = await db.execute<{ name: string; start_date: string; end_date: string; status: string }>(sql`
        SELECT name, start_date::text, end_date::text, status FROM fiscal_year
         WHERE ledger_id = ${ctx.ledgerId}::uuid ORDER BY start_date DESC`)
      const periods = await db.execute<{ name: string; start_date: string; end_date: string; status: string }>(sql`
        SELECT name, start_date::text, end_date::text, status FROM fiscal_period
         WHERE ledger_id = ${ctx.ledgerId}::uuid ORDER BY start_date DESC`)
      return table(
        [`Calendar — ${ctx.entityName}`, `Today is ${localToday()}.`,
         `Fiscal years: ${years.map((y) => `${y.name} ${y.start_date} to ${y.end_date} (${y.status})`).join('; ') || 'none'}.`,
         'Periods, newest first:'],
        ['period', 'from', 'to', 'status'],
        periods.map((p) => [p.name, p.start_date, p.end_date, p.status]))
    },
  },
{
    order: 1,
    name: 'search', args: '{text}', does: 'finds entries, accounts, parties, documents, bank lines, shares, minutes, attachments, employees, pay runs, SR&ED projects, registrations and bill readings that match the text',
    seats: () => ['/search'],
    run: async (ctx, args) => {
      const { hits } = await search(ctx.ledgerId, text(args, 'text'))
      const perKind = new Map<string, number>()
      for (const h of hits) perKind.set(h.kind, (perKind.get(h.kind) ?? 0) + 1)
      const cut = [...perKind].filter(([, n]) => n >= SEARCH_PER_KIND).map(([k]) => k)
      return table(
        [`Search — ${ctx.entityName}`,
         `Each kind lists at most ${SEARCH_PER_KIND} matches${cut.length ? `; these reached that and may have more: ${cut.join(', ')}` : ''}.`,
         'Amounts: a document shows its size (the kind says sales or purchase, invoice or credit note); a bank line keeps the bank\'s sign (money in is positive); an entry or a pay run shows its debit total.'],
        ['kind', 'title', 'detail', 'date', 'amount', 'link'],
        hits.map((h) => [h.kind, h.title, h.detail, h.date ?? '', h.amount === null ? '' : money(h.amount), link(ctx, h.href)]))
    },
  },
{
    order: 2,
    name: 'totals', args: `{by: ${choices(GROUP_BY)}, from, to, type?: ${choices(ACCOUNT_TYPES)}}`,
    does: 'sums of posted lines grouped by account, party or month over whole periods; by party, a whole entry belongs to the party on its first line that names one',
    seats: () => ['/reports'],
    run: async (ctx, args) => {
      const by = oneOf(args, 'by', GROUP_BY)
      const type = oneOf(args, 'type', ACCOUNT_TYPES, false)
      const s = await span(ctx, args)
      const [closing] = await db.execute<{ entry_no: string; entry_date: string }>(sql`
        SELECT entry_no, entry_date::text FROM journal_entry
         WHERE ledger_id = ${ctx.ledgerId}::uuid AND source_type = 'period_close' AND status = 'posted'
           AND entry_date BETWEEN ${s.fromPeriod.start_date}::date AND ${s.toPeriod.end_date}::date
         ORDER BY entry_date LIMIT 1`)
      const closingNote = !closing ? [] : [
        `This range includes the year-end closing entry ${closing.entry_no} (${closing.entry_date}), which moved the year's `
        + 'income into retained earnings: revenue and expense totals show what remains after it. End the range before the '
        + 'closing date to see the year\'s result.']
      const grouped = await db.execute<{ id: string; label: string; debit: string; credit: string; net: string }>(sql`
        WITH lines AS (
          SELECT je.entry_date, jl.debit, jl.credit, jl.amount, a.id AS account_id, a.code, a.name,
                 fp.party_id, fp.party_name
            FROM journal_line jl
            JOIN journal_entry je ON je.id = jl.entry_id
            JOIN account a ON a.id = jl.account_id
            LEFT JOIN LATERAL (
              SELECT p.id AS party_id, p.name AS party_name
                FROM journal_line l2 JOIN party p ON p.id = l2.party_id
               WHERE l2.entry_id = je.id ORDER BY l2.line_no LIMIT 1) fp ON true
           WHERE je.ledger_id = ${ctx.ledgerId}::uuid
             AND je.status IN ('posted', 'reversed')
             AND je.entry_date BETWEEN ${s.fromPeriod.start_date}::date AND ${s.toPeriod.end_date}::date
             ${type ? sql`AND a.account_type = ${type}::account_type` : sql``}
        )
        SELECT ${by === 'account' ? sql`account_id::text` : by === 'party' ? sql`COALESCE(party_id::text, '')` : sql`''`} AS id,
               ${by === 'account' ? sql`min(code || ' ' || name)` : by === 'party' ? sql`COALESCE(min(party_name), 'No party')` : sql`to_char(entry_date, 'YYYY-MM')`} AS label,
               COALESCE(sum(debit), 0)::text AS debit, COALESCE(sum(credit), 0)::text AS credit,
               COALESCE(sum(amount), 0)::text AS net
          FROM lines
         GROUP BY ${by === 'account' ? sql`account_id` : by === 'party' ? sql`party_id` : sql`to_char(entry_date, 'YYYY-MM')`}
         ORDER BY ${by === 'month' ? sql`label` : sql`abs(sum(amount)) DESC, label`}`)
      const sum = (f: 'debit' | 'credit' | 'net') => grouped.reduce((t, r) => t + BigInt(r[f]), 0n)
      return table(
        [...closingNote, `Totals by ${by}${type ? ` (${type} accounts)` : ''} — ${ctx.entityName}`, s.said,
         'Debit and credit are sums of lines; net is debit minus credit (a revenue or liability total is negative).',
         `All ${grouped.length} groups together: debit ${money(sum('debit'))}, credit ${money(sum('credit'))}, net ${money(sum('net'))}.`],
        [by, 'debit', 'credit', 'net', 'link'],
        grouped.map((r) => [r.label, money(r.debit), money(r.credit), money(r.net),
          by === 'account' ? link(ctx, `/accounts/${r.id}`) : by === 'party' && r.id ? link(ctx, `/parties/${r.id}`) : '']))
    },
  },
{
    order: 3,
    name: 'accounts', args: '{text?}', does: 'the chart of accounts: code, name, type, roles, whether in use, and balance',
    seats: () => ['/accounts'],
    run: async (ctx, args) => {
      const q = text(args, 'text', false).toLowerCase()
      const rows = (await chartOfAccounts(ctx.entityId, ctx.ledgerId))
        .filter((a) => !q || a.code.toLowerCase().includes(q) || a.name.toLowerCase().includes(q))
      return table(
        [`Accounts — ${ctx.entityName}`, 'Balance: every posted line to date, debit positive and credit negative.'],
        ['code', 'name', 'type', 'roles', 'in use', 'balance', 'link'],
        rows.map((a) => [a.code, a.name, a.account_type, (a.roles ?? []).join(', '), a.is_active ? 'yes' : 'no',
          money(a.balance), link(ctx, `/accounts/${a.id}`)]))
    },
  },
{
    order: 4,
    name: 'parties', args: '{name?}', does: 'customers, suppliers and everyone else with a role here: name, trading name, tax number, notes, roles; without a name, all of them',
    seats: () => ['/parties'],
    run: async (ctx, args) => {
      const q = text(args, 'name', false).toLowerCase()
      const rows = (await partiesFor(ctx.entityId))
        .filter((p) => !q || p.name.toLowerCase().includes(q) || (p.trading_name ?? '').toLowerCase().includes(q))
      return table(
        [`Parties — ${ctx.entityName}`, 'Use the id in a link for the party in other tools.'],
        ['name', 'trading as', 'kind', 'tax number', 'roles', 'active', 'notes', 'link'],
        rows.map((p) => [p.name, p.trading_name ?? '', p.kind, p.tax_number ?? '', p.roles ?? '', p.is_active ? 'yes' : 'no',
          p.notes ?? '', link(ctx, `/parties/${p.id}`)]))
    },
  },
{
    order: 5,
    name: 'balances', args: '{from, to}', does: 'the trial balance: each account\'s debits and credits over whole periods and its balance at the end',
    seats: () => ['/reports'],
    run: async (ctx, args) => {
      const s = await span(ctx, args)
      const [drift, rows] = await Promise.all([
        driftProblem(ctx.ledgerId), trialBalanceSpan(ctx.ledgerId, s.fromPeriod.id, s.toPeriod.id)])
      const sum = (f: 'debit' | 'credit' | 'balance') => rows.reduce((t, r) => t + BigInt(r[f]), 0n)
      return table(
        [...(drift ? [drift] : []), `Trial balance — ${ctx.entityName}`, s.said,
         'Debit and credit are movement over the range; balance is at its end, debit positive and credit negative.',
         `All ${rows.length} accounts: debit ${money(sum('debit'))}, credit ${money(sum('credit'))}, balances ${money(sum('balance'))}.`],
        ['code', 'name', 'debit', 'credit', 'balance', 'link'],
        rows.map((r) => [r.code, r.name, money(r.debit), money(r.credit), money(r.balance), link(ctx, `/accounts/${r.id}`)]))
    },
  },
{
    order: 6,
    name: 'account_activity', args: '{account: code, from, to}', does: 'one account over whole periods: opening, every posted line with its running balance, closing',
    seats: () => ['/reports'],
    run: async (ctx, args) => {
      const a = await accountByCode(ctx, text(args, 'account'))
      const s = await span(ctx, args)
      const [drift, [gl]] = await Promise.all([
        driftProblem(ctx.ledgerId),
        generalLedger(ctx.ledgerId, { fromPeriodId: s.fromPeriod.id, toPeriodId: s.toPeriod.id,
          fromDate: s.fromPeriod.start_date, toDate: s.toPeriod.end_date }, { accountId: a.id })])
      const head = [...(drift ? [drift] : []), `Account ${a.code} ${a.name} — ${ctx.entityName}`, s.said,
        'Amounts: debit positive, credit negative.']
      if (!gl) return table([...head, 'Nothing moved and nothing stood in this account.'], ['date'], [])
      return table(
        [...head, `Opening ${money(gl.opening)}; debits ${money(gl.debit)}; credits ${money(gl.credit)}; closing ${money(gl.closing)}.`],
        ['date', 'entry', 'description', 'line', 'debit', 'credit', 'running', 'other accounts', 'link'],
        gl.rows.map((r) => [r.entry_date, r.entry_no, r.description, r.line_description ?? '', money(r.debit), money(r.credit),
          money(r.running), (r.contra_codes ?? []).join(', '), link(ctx, `/entries/${r.entry_id}`)]))
    },
  },
{
    order: 7,
    name: 'statement', args: `{which: ${choices(STATEMENT_KEYS)}, from, to}`,
    does: 'a financial statement over whole periods, line by line, with its problems',
    seats: () => ['/reports'],
    run: async (ctx, args) => {
      const which = oneOf(args, 'which', STATEMENT_KEYS) as
        'balance_sheet' | 'profit_loss' | 'cash_flow' | 'equity_changes'
      const s = await span(ctx, args)
      const page = reportLink(ctx.ledgerId, which, { from: s.fromPeriod.start_date, to: s.toPeriod.end_date })
      const pageLine = 'error' in page ? '' : `Page: ${page.page}`
      if (which === 'cash_flow') {
        const cf = await renderCashFlow(ctx.ledgerId, s.toPeriod.id, s.fromPeriod.id)
        if (!cf) throw new ArgError('No cash flow statement for that range.')
        return table(
          [...cf.problems, `Statement of cash flows — ${ctx.entityName}`, s.said, 'Inflows positive, outflows negative.',
           `Cash at the beginning ${money(cf.beginning)}; net change ${money(cf.netChange)}; at the end ${money(cf.ending)}.`, pageLine],
          ['line', 'amount'],
          cf.lines.filter((l) => l.lineType !== 'spacer')
            .map((l) => [`${'  '.repeat(l.indent)}${l.label}`, l.lineType === 'header' ? '' : money(l.raw)]))
      }
      if (which === 'equity_changes') {
        const eq = await renderEquityChanges(ctx.ledgerId, s.toPeriod.id, s.fromPeriod.id)
        if (!eq) throw new ArgError('No statement of changes in equity for that range.')
        return table(
          [...eq.problems, `Statement of changes in equity — ${ctx.entityName}`, s.said,
           'Amounts as the statement shows them: equity increases positive.', pageLine],
          ['line', ...eq.columns.map((c) => c.label), 'total'],
          eq.rows.map((r) => [r.label, ...r.shown.map((v) => money(v))]))
      }
      const st = await renderStatement(ctx.ledgerId, which === 'balance_sheet' ? 'IFRS_SFP_EN' : 'IFRS_PL_NATURE_EN',
        s.toPeriod.id, s.fromPeriod.id)
      if (!st) throw new ArgError('No statement for that range.')
      return table(
        [...st.problems, `${st.template.name} — ${ctx.entityName}`, s.said,
         'Amounts as the statement shows them (revenue, liabilities and equity positive where the statement flips their sign).', pageLine],
        ['line', 'amount'],
        st.lines.filter((l) => l.lineType !== 'spacer')
          .map((l) => [`${'  '.repeat(l.indent)}${l.label}`, l.lineType === 'header' ? '' : money(l.shown)]))
    },
  },
{
    order: 8,
    name: 'owed', args: `{side: ${choices(SIDES)}, party?: id, as_of?}`, does: 'who owes what, by party and by how overdue, as at a date (today if none)',
    seats: () => ['/reports'],
    run: async (ctx, args) => {
      const side = oneOf(args, 'side', SIDES)
      const party = text(args, 'party', false)
      if (party) await mustBeOurs('party', party, ctx.ledgerId)
      const asOf = date(args, 'as_of', false) || localToday()
      const report = await aging(ctx.ledgerId, side === 'receivable' ? 'trade_receivables' : 'trade_payables', asOf)
      const flip = side === 'payable' ? -1n : 1n
      const rows = report.rows.filter((r) => !party || r.party_id === party)
      const total = rows.reduce((t, r) => t + r.total * flip, 0n)
      return table(
        [`${side === 'receivable' ? 'Owed to us' : 'Owed by us'} as at ${asOf} — ${ctx.entityName}`,
         side === 'receivable' ? 'Positive: they owe us.' : 'Positive: we owe them.',
         `All ${rows.length} parties together: ${money(total)}.`],
        ['party', ...BUCKETS.map((b) => b.label), 'total', 'link'],
        rows.map((r) => [r.party_name, ...r.buckets.map((b) => money(b * flip)), money(r.total * flip), link(ctx, `/parties/${r.party_id}`)]))
    },
  },
{
    order: 9,
    name: 'open_documents', args: `{direction?: ${choices(INVOICE_DIRECTIONS)}, party?: id}`, does: 'invoices and credit notes not yet settled, as they stand today',
    seats: () => ['/invoices'],
    run: async (ctx, args) => {
      const direction = oneOf(args, 'direction', INVOICE_DIRECTIONS, false)
      const party = text(args, 'party', false)
      if (party) await mustBeOurs('party', party, ctx.ledgerId)
      const rows = (await openItemsFor(ctx.ledgerId))
        .filter((i) => (!direction || i.direction === direction) && (!party || i.party_id === party))
      return table(
        [`Unsettled documents today — ${ctx.entityName}`,
         'Balance: what is still owed on the document; a credit note\'s unspent value is negative, because it reduces what is owed.'],
        ['number', 'kind', 'direction', 'party', 'issued', 'due', 'original CAD', 'applied CAD', 'balance CAD', 'link', 'currency', 'native original', 'native applied', 'native balance'],
        rows.map((i) => [i.number ?? 'unnumbered', i.document_kind, i.direction, i.party_name, i.issued_on, i.due_on,
          money(i.debt), money(i.applied), money(owedAmount(i)), link(ctx, invoicePath(i.direction === 'purchase' ? 'purchase' : 'sales', i.invoice_id)), i.currency ?? 'CAD', formatNative(i.native_debt ?? i.debt,i.currency ?? 'CAD'), formatNative(i.native_applied ?? i.applied,i.currency ?? 'CAD'), formatNative(i.native_balance ?? i.balance,i.currency ?? 'CAD')]))
    },
  },
{
    order: 10,
    name: 'party_activity', args: `{party: id, direction: ${choices(PARTY_FLOW)}, from, to}`, does: 'what one party was paid or paid us for in a range: bills, invoices, expenses, payments, drafts, with what is still unpaid',
    offeredTo: ['/expenses', '/income'],
    // A direction that is neither refuses anybody with narrower seats; the owner is told the argument is wrong.
    seats: (args) => (args.direction === 'in' ? ['/income'] : args.direction === 'out' ? ['/expenses'] : []),
    run: async (ctx, args) => {
      const party = text(args, 'party')
      await mustBeOurs('party', party, ctx.ledgerId)
      const direction = oneOf(args, 'direction', PARTY_FLOW) as 'out' | 'in'
      const from = date(args, 'from')
      const to = date(args, 'to')
      const rows = (await partyLedger(ctx.ledgerId, direction, from, to)).filter((r) => r.party_id === party)
      return table(
        [`${direction === 'out' ? 'Money out' : 'Money in'} with one party, ${from} to ${to} — ${ctx.entityName}`,
         `P&L amount: what the row put into ${direction === 'out' ? 'expenses (positive)' : 'revenue (negative)'}; empty for payments and for documents not in the books.`,
         'Unpaid: still owed today; a credit note\'s is negative. Payments carry no amount here.'],
        ['kind', 'state', 'date', 'description', 'reference', 'entry', 'p&l amount', 'unpaid', 'link'],
        rows.map((r) => [r.kind, r.state, r.on_date, r.description, r.doc_ref ?? '', r.entry_no ?? '',
          money(r.pl_amount), money(r.unpaid),
          link(ctx, r.href.kind === 'invoice' ? invoicePath(direction === 'in' ? 'sales' : 'purchase', r.href.id) : `/entries/${r.href.id}`)]))
    },
  },
{
    order: 11,
    name: 'journal', args: '{text?, from?, to?}', does: 'posted entries, newest first, with every line; text matches descriptions, references, entry numbers, amounts and dates',
    seats: () => ['/entries'],
    run: async (ctx, args) => {
      const q = text(args, 'text', false)
      const rows = await journalEntries(ctx.ledgerId, {
        status: 'posted', q: q ? readQuery(q) : undefined,
        from: date(args, 'from', false) || undefined, to: date(args, 'to', false) || undefined, limit: RESULT_ROWS + 1,
      })
      return table(
        [`Journal entries — ${ctx.entityName}`, 'Each line: account, then debit or credit.'],
        ['entry', 'date', 'status', 'description', 'total', 'lines', 'reverses / reversed by', 'link'],
        rows.slice(0, RESULT_ROWS).map((e) => [e.entry_no ?? 'draft', e.entry_date, e.status, e.description, money(e.total),
          e.accounts.map((code, i) => `${code} ${e.names[i] ?? ''} ${BigInt(e.debits[i] ?? '0') !== 0n ? `Dr ${money(e.debits[i])}` : `Cr ${money(e.credits[i])}`}${e.original_currencies[i] ? `; native ${e.original_currencies[i]} ${nativeInput(BigInt(e.original_amounts[i]),e.original_currencies[i])}; evidence ${e.fx_snapshots[i]}` : ''}`).join('; '),
          [e.reverses ? `reverses ${e.reverses}` : '', e.reversed_by ? `reversed by ${e.reversed_by}` : ''].filter(Boolean).join(', '),
          link(ctx, `/entries/${e.id}`)]),
        { more: rows.length > RESULT_ROWS })
    },
  },
{
    order: 12,
    name: 'bank_lines', args: `{account: code, from?, to?, state?: ${choices(BANK_ROW_STATES)}}`, does: 'the imported bank rows of one bank account, with how far each is matched',
    seats: () => ['/bank'],
    run: async (ctx, args) => {
      const a = await accountByCode(ctx, text(args, 'account'))
      if (!(await accountInLedger(a.id, ctx.ledgerId))) throw new ArgError(NOT_OURS)
      const [bankCurrency]=await db.execute<{currency:string}>(sql`SELECT COALESCE(foreign_currency,'CAD') AS currency FROM account WHERE id=${a.id}::uuid`)
      const state = oneOf(args, 'state', BANK_ROW_STATES, false)
      const from = date(args, 'from', false)
      const to = date(args, 'to', false)
      const rows = (await bankRows(a.id, state ? { state } : {}))
        .filter((r) => (!from || r.txn_date >= from) && (!to || r.txn_date <= to))
      return table(
        [`Bank rows of ${a.code} ${a.name} — ${ctx.entityName}`, `Amounts in ${bankCurrency.currency} keep the bank's sign: money in is positive.`],
        ['date', 'amount', 'bank text', 'state', 'matched', 'not matched', 'ignored because', 'file'],
        rows.map((r) => [r.txn_date, formatNative(r.amount,bankCurrency.currency), r.description, r.state, formatNative(r.matched_amount,bankCurrency.currency), formatNative(r.unmatched_amount,bankCurrency.currency),
          r.ignored_reason ?? '', r.source_file ?? '']))
    },
  },
{
    order: 13,
    name: 'bank_accounts', args: '{}', does: 'each bank account: rows imported, rows to review, the latest statement, reconciled through, the books\' balance and the statement\'s',
    seats: () => ['/bank'],
    run: async (ctx) => {
      const rows = await accountStandings(ctx.entityId)
      return table(
        [`Bank accounts — ${ctx.entityName}`, 'Balances are signed the way the account normally sits: money in a bank account, or owed on a card, is positive.'],
        ['account', 'rows', 'to review', 'latest statement', 'reconciled through', 'books', 'statement', 'link'],
        rows.map((r) => [`${r.code} ${r.name} (${r.currency})`, String(r.rows), String(r.review), r.newestStatement ?? '', r.finishedThrough ?? '',
          formatNative(r.books,r.currency ?? 'CAD'), r.statement===null ? '' : formatNative(r.statement,r.currency ?? 'CAD'), link(ctx, `/bank/${r.id}`)]))
    },
  },
{
    order: 14,
    name: 'tax_return', args: `{tax: ${choices(TAX_RETURN_KEYS)}, from, to}`, does: 'the sales tax return for exactly those dates, line by line, with what needs review',
    seats: () => ['/tax'],
    run: async (ctx, args) => {
      const tax = oneOf(args, 'tax', TAX_RETURN_KEYS)
      const from = date(args, 'from')
      const to = date(args, 'to')
      if (from > to) throw new ArgError('"from" is after "to".')
      const r = tax === 'gst_hst' ? await gstHstReturn(ctx.ledgerId, from, to) : await pstReturn(ctx.ledgerId, from, to)
      if (!r) throw new ArgError('There is no return for that company and range.')
      const page = reportLink(ctx.ledgerId, tax, { from, to })
      const lines = Object.values(r.lines)
      return table(
        [`${tax === 'gst_hst' ? 'GST/HST' : 'PST'} return ${r.from} to ${r.to} — ${r.entity}`,
         `Business number: ${r.businessNumber ?? 'none'}. Registered for ${r.coverage} of the range: `
           + (r.registrations.map((g) => `${g.number} from ${g.registeredOn}${g.ceasedOn ? ` to ${g.ceasedOn}` : ''}`).join('; ') || 'no registration') + '.',
         ...r.review.map((v) => `Review — ${v.what}: ${v.detail}${v.entries?.length ? ` (${v.entries.map((e) => `${e.entryNo} ${e.entryDate} ${e.description}`).join('; ')})` : ''}`),
         'error' in page ? '' : `Page: ${page.page}`],
        ['line', 'label', 'books', 'adjustment', 'return amount'],
        lines.map((l) => [l.line, l.label, money(l.bookAmount ?? l.amount), money(l.adjustment ?? 0n), money(l.amount)]))
    },
  },
{
    order: 33,
    name: 'module_link', args: '{}', does: 'the safe Banyan page for the selected ERP skill; the server chooses the address',
    seats: () => null,
    run: async (ctx) => {
      if (!ctx.skill) throw new ArgError('No ERP skill was selected for this question.')
      const destination = await moduleDestination(ctx.ledgerId, ctx.user, ctx.skill)
      return `${destination.label} — ${ctx.entityName}\nPage: ${destination.href}`
    },
  },
{
    order: 34,
    name: 'calculate', args: `{op: ${choices(CALC_OPS)}, amounts: [..]}`, does: 'adds amounts, or takes the rest from the first, exactly; every amount must be one already in this question\'s results',
    seats: () => null,
    run: async (_ctx, args, known) => {
      const op = oneOf(args, 'op', CALC_OPS)
      const list = args.amounts
      if (!Array.isArray(list) || list.length < 2) throw new ArgError('"amounts" must be a list of at least two amounts.')
      const cents = list.map((v, i) => {
        const s = String(v).replace(/[$,\s]/g, '')
        const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(s)
        if (!m) throw new ArgError(`Amount ${i + 1} is not an amount.`)
        const c = BigInt(m[2]) * 100n + BigInt((m[3] ?? '').padEnd(2, '0'))
        if (!known.has(c)) throw new ArgError(`Amount ${i + 1} is not a figure from this question's results. Look it up first.`)
        return m[1] ? -c : c
      })
      const value = op === 'sum' ? cents.reduce((t, c) => t + c, 0n) : cents.slice(1).reduce((t, c) => t - c, cents[0])
      return `calculate ${op}\nResult: ${money(value)}`
    },
  },
{
    order: 35,
    name: 'report_link', args: '{report, from?, to?, as_of?, party?: id, year?}',
    does: `the page and download addresses of a report; report is one of ${Object.keys(REPORTS).join(', ')}`,
    offeredTo: ['/reports', '/parties', '/tax', '/payroll'],
    seats: (args, ledgerId) => {
      const r = String(args.report ?? '')
      return isReportKey(r) ? (seatsForPath(ledgerId, `/ledger/${ledgerId}${REPORTS[r].seatPath}`) ?? []) : []
    },
    run: async (ctx, args) => {
      const party = text(args, 'party', false)
      if (party) await mustBeOurs('party', party, ctx.ledgerId)
      const built = reportLink(ctx.ledgerId, text(args, 'report'), {
        from: date(args, 'from', false), to: date(args, 'to', false), as_of: date(args, 'as_of', false),
        party, year: text(args, 'year', false),
      })
      if ('error' in built) throw new ArgError(built.error)
      return [`${built.label} — ${ctx.entityName}`, `Page: ${built.page}`,
        ...built.downloads.map((d) => `${d.label}: ${d.href}`)].join('\n')
    },
  },
]

async function installedTools(): Promise<Tool[]> {
  const tools = [...TOOLS, ...await moduleInquiryTools()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  if (new Set(tools.map(tool => tool.name)).size !== tools.length) throw new Error('Two modules declared the same inquiry tool.')
  return tools
}

/** The tools this person may use here, for the system text. `calculate` needs no seat. */
export async function toolList(ctx: ToolContext, skill?: SkillId, only?: ReadonlySet<string>): Promise<ToolSpec[]> {
  const out: ToolSpec[] = []
  const allowed = skill ? toolNamesForSkill(skill) : null
  for (const t of await installedTools()) {
    if (only && !only.has(t.name)) continue
    if (allowed && !allowed.has(t.name)) continue
    const seats = t.offeredTo ?? t.seats({}, ctx.ledgerId)
    if (seats === null || (await refuseForLedger(ctx.user, ctx.ledgerId, seats)) === null) {
      out.push({ name: t.name, args: t.args, does: t.does })
    }
  }
  return out
}

/**
 * One look-up. Whatever goes wrong comes back as a sentence for the model —
 * an unknown tool, a missing argument, a seat not held, an id not ours — and
 * no sentence repeats an amount, so a refusal cannot put a figure into the
 * question's results.
 */
export async function runTool(ctx: ToolContext, name: string, args: Args, known: Set<bigint>, options: { hideInternalErrors?: boolean } = {}): Promise<string> {
  const tools = await installedTools()
  const tool = tools.find(tool => tool.name === name.trim())
  const allowed = ctx.skill ? toolNamesForSkill(ctx.skill) : null
  if (!tool || (allowed && !allowed.has(tool.name))) {
    const names = tools.filter(tool => !allowed || allowed.has(tool.name)).map(tool => tool.name)
    return `There is no tool by that name in ${ctx.skill ? skillById(ctx.skill).label : 'this assistant'}. The tools are: ${names.join(', ')}.`
  }
  const clean = tidy(args)
  const seats = tool.seats(clean, ctx.ledgerId)
  if (seats !== null) {
    const refusal = await refuseForLedger(ctx.user, ctx.ledgerId, seats)
    if (refusal) return `Refused: ${refusal.message}`
  }
  try {
    return await tool.run(ctx, clean, known)
  } catch (e) {
    if (e instanceof ArgError) return `${tool.name}: ${e.message}`
    if (options.hideInternalErrors) return `${tool.name}: The books could not be read. Ask the operator to check the server.`
    return `${tool.name} could not be read: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`
  }
}
