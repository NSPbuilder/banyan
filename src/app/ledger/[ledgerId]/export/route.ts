import { guardRoute } from '@/lib/gate'
import { NextRequest } from 'next/server'
import { filename } from '@/lib/csv'
import { rowsXlsx } from '@/lib/excel'
import { HIDE_ZEROS } from '@/lib/reporting-view'
import {
  accountLedgerCsv, breakdownCsv, gstHstCsv, journalCsv, statementCsv, taxCsv, trialBalanceCsv, pd7aCsv,
} from '@/lib/exports'
import { NOT_OURS, ours } from '@/lib/ours'

/**
 * One route for every CSV the app produces.
 *
 *   ?what=trial-balance&period=<id>
 *   ?what=account&account=<id>[&from=<date>&to=<date>]
 *   ?what=journal
 *   ?what=statement&template=<code>&period=<id>
 *   ?what=breakdown&kind=...      the drill-down behind a report figure,
 *                                 with the kind's own params passed through
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ ledgerId: string }> },
) {
  const who = await guardRoute()
  if (who instanceof Response) return who

  const { ledgerId } = await params
  const q = request.nextUrl.searchParams
  const what = q.get('what')
  const xlsx = q.get('format') === 'xlsx'
  // A workbook from THIS route only for the three grids that have no paper of
  // their own. The others have a report builder that lays the same blocks as
  // the PDF; the row-grid heuristic here would bold and freeze a statement's
  // warning row as if it were the header (critic, 2026-09-04).
  const GRIDS_AS_XLSX = ['journal', 'account', 'pd7a']
  if (xlsx && what && !GRIDS_AS_XLSX.includes(what)) {
    return bad(`Excel for ${what} comes from its own report page — this route makes a workbook `
      + `only for what=journal, account or pd7a.`)
  }

  try {
    let csv: string | undefined
    let rows: Array<Array<string | number | null | undefined>> | undefined
    let name: string | undefined

    if (what === 'trial-balance') {
      const periodId = q.get('period')
      if (!periodId) return bad('A period is needed for a trial balance.')
      const r = await trialBalanceCsv(ledgerId, periodId, q.get('fromPeriod') ?? periodId,
        { hideZeros: q.get(HIDE_ZEROS) === '1' })
      csv = r.csv
      rows = r.rows
      name = filename([r.entity, 'trial-balance', r.period])
    } else if (what === 'account') {
      const accountId = q.get('account')
      if (!accountId) return bad('An account is needed.')
      if (!(await ours('account', accountId, ledgerId))) return new Response(NOT_OURS, { status: 404 })
      const r = await accountLedgerCsv(ledgerId, accountId, {
        from: q.get('from') ?? undefined, to: q.get('to') ?? undefined,
      })
      csv = r.csv
      rows = r.rows
      name = filename([r.entity, r.account])
    } else if (what === 'journal') {
      const r = await journalCsv(ledgerId)
      csv = r.csv
      rows = r.rows
      name = filename([r.entity, 'journal'])
    } else if (what === 'pd7a') {
      const year = Number(q.get('year') ?? '')
      if (!year) return bad('A year is needed for the PD7A worksheet.')
      const r = await pd7aCsv(ledgerId, year)
      if (!r) return bad('There is no such ledger.')
      csv = r.csv
      rows = r.rows
      name = filename([r.entity, 'pd7a', String(year)])
    } else if (what === 'pst') {
      const from = q.get('from'), to = q.get('to')
      if (!from || !to) return bad('A date range is needed for a PST return.')
      const r = await taxCsv(ledgerId, from, to, 'PST')
      if (!r) return bad('There is no such ledger.')
      csv = r.csv
      rows = r.rows
      name = filename([r.entity, 'pst', `${r.from}_${r.to}`])
    } else if (what === 'gst-hst') {
      const from = q.get('from'), to = q.get('to')
      if (!from || !to) return bad('A date range is needed for a GST/HST return.')
      const r = await gstHstCsv(ledgerId, from, to)
      if (!r) return bad('There is no such ledger.')
      csv = r.csv
      rows = r.rows
      name = filename([r.entity, 'gst-hst', `${r.from}_${r.to}`])
    } else if (what === 'statement') {
      const template = q.get('template')
      const periodId = q.get('period')
      if (!template || !periodId) return bad('A statement and a period are both needed.')
      const r = await statementCsv(ledgerId, template, periodId, q.get('fromPeriod') ?? periodId)
      if (!r) return bad('There is no such statement.')
      csv = r.csv
      rows = r.rows
      name = filename([r.entity, r.name, r.period])
    } else if (what === 'breakdown') {
      const r = await breakdownCsv(ledgerId, Object.fromEntries(q))
      if (!r) return bad('No such breakdown. The address needs a kind and its parameters.')
      csv = r.csv
      rows = r.rows
      name = r.name
    } else {
      return bad('Nothing to export. Say what=trial-balance, account, journal, pd7a, statement, gst-hst, pst or breakdown.')
    }

    // The same rows as a workbook: title row, bold header, money as numbers.
    if (xlsx && rows) {
      const buffer = await rowsXlsx(String(rows[0]?.[1] ?? what), rows)
      return new Response(new Uint8Array(buffer), {
        headers: {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="${name!.replace(/\.csv$/, '.xlsx')}"`,
          'Cache-Control': 'no-store',
        },
      })
    }
    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${name}"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (e) {
    // Say what went wrong in the body: a download that fails silently looks to
    // the person like a browser problem.
    const message = e instanceof Error ? ((e.cause as Error | undefined)?.message ?? e.message) : String(e)
    return new Response(`Export failed: ${message.split('\n')[0]}\n`, {
      status: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }
}

const bad = (message: string) =>
  new Response(`${message}\n`, { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
