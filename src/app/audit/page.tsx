
import { formatNumber } from '@/lib/numbers'
import { ToolAction } from '@/components/ToolAction'
import { TOOL_BUTTON } from '@/lib/ui'
import { requireOwner } from '@/lib/gate'
import { ApplicationFrame } from '@/components/ApplicationFrame'
import { GlobalNavigation } from '@/components/GlobalNavigation'
import { PageHeader } from '@/components/PageHeader'
import Link from 'next/link'
import { AUDIT_LIMIT, auditFilterFrom, auditTrail, auditVocabulary } from '@/lib/audit'
import { FilterBar } from '@/components/FormLayout'
import { MoreFilters } from '@/components/MoreFilters'
import { TimestampText } from '@/components/AccountingData'
import { DataTable, TableViewport } from '@/components/Table'
import { Pagination } from '@/components/Pagination'
import { QUIET, LABEL, FIELD } from '@/lib/ui'
import {auditVerificationStatus} from '@/lib/audit-chain'
import {AuditControls} from './AuditControls'

export const dynamic = 'force-dynamic'

/**
 * The audit trail — who did what, when, to which row, with before and after.
 *
 * Owner-only: the trail spans every company and names tables and ids, not
 * ledgers. It is a reader and nothing else; nothing here writes.
 */
export default async function Audit({
  searchParams,
}: { searchParams: Promise<Record<string, string | undefined>> }) {
  const me = await requireOwner()
  const q = await searchParams
  const filter = auditFilterFrom(q)
  const [rows, vocab] = await Promise.all([auditTrail(filter), auditVocabulary()])
  const verification=await auditVerificationStatus()
  const stale=!verification.latest||Date.parse(verification.observedAt)-Date.parse(verification.latest.checked_at)>86400000
  const exportParams = new URLSearchParams()
  for (const [key, value] of Object.entries(filter)) {
    if (typeof value === 'string') exportParams.set(key, value)
  }
  const exportHref = `/audit/export${exportParams.size ? `?${exportParams}` : ''}`
  const pageSize = 50
  const page = Math.min(Math.max(1, /^\d+$/.test(q.page ?? '') ? Number(q.page) || 1 : 1), Math.max(1, Math.ceil(rows.length / pageSize)))
  const visibleRows = rows.slice((page - 1) * pageSize, page * pageSize)
  const pageHref = (next: number) => { const params = new URLSearchParams(exportParams); params.set('page', String(next)); return `/audit?${params}` }

  const field = FIELD
  const label = LABEL

  return (
    <ApplicationFrame navigation={<GlobalNavigation owner={me.is_owner} />} context={{ name: 'Workspace' }}>
    <main className="w-full max-w-none px-8 py-6 font-sans">
      <PageHeader title="Audit trail" backTo="/companies" backLabel="Back to Companies" />

      <section className="mt-5 max-w-3xl border-b border-line-subtle pb-4" aria-label="Audit integrity">
        <h2 className="font-medium">Audit integrity</h2>
        <p className="mt-2 text-sm">Verifiable since the legacy seal: <TimestampText value={verification.seal.sealed_at}/>. {verification.seal.row_count} historical rows were sealed; this does not prove their earlier history.</p>
        <p className="mt-2 text-sm" role="status">{!verification.latest?'No verification has run.':verification.latest.result.ok?'Latest verification passed.':'Latest verification failed.'} {stale?'A daily verification is due.':''}</p>
        <p className="mt-1 text-xs text-ink-muted">Last success: <TimestampText value={verification.lastSuccess ?? null}/>. Latest check: <TimestampText value={verification.latest?.checked_at ?? null}/>.</p>
        {verification.latest&&!verification.latest.result.ok&&<ul className="mt-2 text-sm" role="alert">{verification.latest.result.issues.map((i,n)=><li key={n}>{i.scope} · sequence {i.sequence??'—'} · {i.type}</li>)}</ul>}
        <p className="mt-2 text-xs text-ink-muted">{verification.latest?.result.independentCheckpointCompared?'An operator-supplied checkpoint was compared at its recorded sequence.':'No independently retained checkpoint has been compared.'} A same-database checkpoint cannot prove that the tail was not rewritten.</p>
        <AuditControls/>
      </section>

      <form method="get" className="mt-5">
        <FilterBar actions={<><button type="submit" className={QUIET}>Apply</button><Link href="/audit" className="text-label underline">Clear</Link><a href={exportHref} className={TOOL_BUTTON} title="Export CSV"><ToolAction kind="csv">Export CSV</ToolAction></a></>}>
        <label className={label}>Company
          <select name="entity" defaultValue={filter.entity ?? ''} className={`mt-1 block max-w-56 ${field}`}>
            <option value="">any</option>
            {vocab.entities.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
          </select>
        </label>
        <label className={label}>From
          <input type="date" name="from" defaultValue={filter.from ?? ''} className={`mt-1 block ${field}`} />
        </label>
        <label className={label}>To
          <input type="date" name="to" defaultValue={filter.to ?? ''} className={`mt-1 block ${field}`} />
        </label>
          <MoreFilters active={[filter.actor, filter.action, filter.table, filter.scope, filter.ledger, filter.record].filter(Boolean).length}>
        <label className={label}>Who
          <select name="actor" defaultValue={filter.actor ?? ''} className={`mt-1 block ${field}`}>
            <option value="">anyone</option>
            {vocab.actors.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
        <label className={label}>What
          <select name="action" defaultValue={filter.action ?? ''} className={`mt-1 block ${field}`}>
            <option value="">anything</option>
            {vocab.actions.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
        <label className={label}>Table
          <select name="table" defaultValue={filter.table ?? ''} className={`mt-1 block ${field}`}>
            <option value="">any</option>
            {vocab.tables.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label className={label}>Scope
          <select name="scope" defaultValue={filter.scope ?? ''} className={`mt-1 block ${field}`}>
            <option value="">any</option>
            <option value="company">company</option>
            <option value="shared">shared</option>
            <option value="system">system</option>
            <option value="unresolved">unresolved</option>
          </select>
        </label>
        <label className={label}>Ledger
          <select name="ledger" defaultValue={filter.ledger ?? ''} className={`mt-1 block max-w-56 ${field}`}>
            <option value="">any</option>
            {vocab.ledgers.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select>
        </label>
        <label className={label}>Record id
          <input name="record" defaultValue={filter.record ?? ''}
                 className={`mt-1 block w-44 ${field}`} />
        </label>
          </MoreFilters>
        </FilterBar>
      </form>

      <p className="mt-4 text-xs text-neutral-500">
        {rows.length === 0 ? 'Nothing matches.'
          : rows.length >= AUDIT_LIMIT ? `The newest ${AUDIT_LIMIT} — narrow the filters to see further back.`
          : `${formatNumber(rows.length)} ${rows.length === 1 ? 'row' : 'rows'}, newest first.`}
      </p>

      {rows.length > 0 && (
        <TableViewport label="Audit events" className="mt-2">
        <DataTable density="reading" className="mt-2 min-w-[72rem] w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-neutral-300 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
              <th className="py-2 pr-3 font-medium">When</th>
              <th className="py-2 pr-3 font-medium">Who</th>
              <th className="py-2 pr-3 font-medium">What</th>
              <th className="py-2 pr-3 font-medium">Table · record</th>
              <th className="py-2 pr-3 font-medium">Scope · company</th>
              <th className="py-2 pr-3 font-medium">Reason</th>
              <th className="py-2 font-medium">Before → after</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((r) => (
              <tr key={r.id} className="border-b border-neutral-100 align-top dark:border-neutral-900" data-audit={r.id}>
                <td className="whitespace-nowrap py-2 pr-3 font-mono text-xs text-neutral-500">
                  <TimestampText value={r.occurred_at} />
                </td>
                <td className="whitespace-nowrap py-2 pr-3 text-xs">{r.actor}</td>
                <td className="whitespace-nowrap py-2 pr-3 font-mono text-xs">{r.action}</td>
                <td className="py-2 pr-3 font-mono text-xs text-neutral-500">
                  {r.table_name}
                  <span className="block text-xs">{r.chain_id?`Chain sequence ${r.chain_seq}`:'Legacy · sealed at cutover'}</span>
                  {r.source==='portable_history_import'&&<span className="block text-xs">Source history · verified since copy</span>}
                  {r.target_label && <span className="block max-w-44 truncate" title={r.target_label}>{r.target_label}</span>}
                  {r.record_id && <span className="block truncate" title={r.record_id}>{r.record_id.slice(0, 8)}…</span>}
                </td>
                <td className="py-2 pr-3 text-xs text-neutral-500">
                  <span className="font-mono">{r.scope}</span>
                  {(r.entity_name || r.entity_id) && <span className="block max-w-44 truncate" title={r.entity_id ?? undefined}>{r.entity_name ?? `${r.entity_id?.slice(0, 8)}…`}</span>}
                  {(r.ledger_name || r.ledger_id) && <span className="block max-w-44 truncate" title={r.ledger_id ?? undefined}>{r.ledger_name ?? `${r.ledger_id?.slice(0, 8)}…`}</span>}
                </td>
                <td className="max-w-56 py-2 pr-3 text-xs">
                  {r.reason ?? <span className="text-neutral-400">—</span>}
                </td>
                <td className="py-2 font-mono text-xs">
                  <Change before={r.before} after={r.after} context={r.context} />
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
        </TableViewport>
      )}
      {rows.length > pageSize && <Pagination page={page} pageSize={pageSize} total={rows.length} count={visibleRows.length}
        previous={page > 1 ? pageHref(page - 1) : undefined} next={page * pageSize < rows.length ? pageHref(page + 1) : undefined} label="Audit pages"/>}
    </main>
    </ApplicationFrame>
  )
}

/**
 * What changed, as "key: before → after" lines — only the keys that differ,
 * or all of them when only one side exists (a creation, a deletion).
 */
function Change({ before, after, context }: { before: unknown; after: unknown; context: unknown }) {
  const b = (before && typeof before === 'object' ? before : {}) as Record<string, unknown>
  const a = (after && typeof after === 'object' ? after : {}) as Record<string, unknown>
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])]
    .filter((k) => JSON.stringify(b[k]) !== JSON.stringify(a[k]))
  const show = (v: unknown) => v === undefined ? '—' : typeof v === 'string' ? v : JSON.stringify(v)
  const ctx = context && typeof context === 'object' ? Object.entries(context as Record<string, unknown>) : []
  return (
    <div className="max-w-xl">
      {keys.length === 0 && <span className="text-neutral-400">—</span>}
      {keys.map((k) => (
        <div key={k} className="truncate" title={`${k}: ${show(b[k])} → ${show(a[k])}`}>
          <span className="text-neutral-500">{k}:</span>{' '}
          {k in b && <span className="text-neutral-500 line-through">{show(b[k])}</span>}
          {k in b && k in a && ' → '}
          {k in a && <span>{show(a[k])}</span>}
        </div>
      ))}
      {ctx.length > 0 && (
        <div className="mt-0.5 truncate text-neutral-400" title={JSON.stringify(context)}>
          {ctx.map(([k, v]) => `${k}=${show(v)}`).join(' · ')}
        </div>
      )}
    </div>
  )
}
