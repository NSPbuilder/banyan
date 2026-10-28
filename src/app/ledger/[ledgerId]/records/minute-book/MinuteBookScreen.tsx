'use client'

import { useState } from 'react'
import Link from 'next/link'
import { PageHeader } from '@/components/PageHeader'
import { Floating } from '@/components/Floating'
import { ActionForm } from '@/components/ActionForm'
import { DateInput } from '@/components/DateInput'
import { Icon } from '@/components/Icon'
import { DataTable, TableViewport } from '@/components/Table'
import { FilterBar } from '@/components/FormLayout'
import { BUTTON, DANGER, FIELD, GHOST, LABEL, QUIET, TABLE_ACTION, TOOL_BUTTON } from '@/lib/ui'
import { RECORD_FIELDS as F, rowField } from '@/lib/forms'
import { formatNumber } from '@/lib/numbers'
import { MINUTE_CATEGORIES, minuteFileSize, minuteKindLabel, type MinuteRecordView } from '@/lib/minute-book'
import { correctRowAction, deleteRecordRowAction, detachMinuteBookAction } from '@/app/records-actions'
import { MinuteBookUpload } from './MinuteBookUpload'

export function MinuteBookRecordPanel({ ledgerId, record, today, kinds }: {
  ledgerId: string; record: MinuteRecordView; today: string; kinds: string[]
}) {
  const [editing, setEditing] = useState(false)
  const which = <>
    <input type="hidden" name={F.ledgerId} value={ledgerId} />
    <input type="hidden" name={F.table} value="minute_book" />
    <input type="hidden" name={F.recordId} value={record.id} />
  </>
  return <div className="space-y-5">
    {editing ? <ActionForm action={correctRowAction} submit="Save changes" working="Saving…" buttonClassName={BUTTON}
      onSucceeded={() => setEditing(false)} className="space-y-3" stickyActions
      secondaryActions={<button type="button" className={GHOST} onClick={() => setEditing(false)}>Cancel</button>}>
      {which}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={LABEL}>Category<select name={rowField(0, 'recordKind')} aria-label="Category" defaultValue={record.record_kind} required className={`${FIELD} mt-1 block w-full`}>
          {kinds.map(k => <option key={k} value={k}>{minuteKindLabel(k)}</option>)}
        </select></label>
        <label className={LABEL}>Record date<DateInput name={rowField(0, 'onDate')} defaultValue={record.on_date} required className={`${FIELD} mt-1 block w-full`} /></label>
        <label className={`${LABEL} sm:col-span-2`}>Title<input name={rowField(0, 'title')} defaultValue={record.title} required maxLength={255} className={`${FIELD} mt-1 block w-full`} /></label>
        <label className={`${LABEL} sm:col-span-2`}>Note<textarea name={rowField(0, 'note')} defaultValue={record.note ?? ''} rows={2} maxLength={10000} className={`${FIELD} mt-1 block w-full`} /></label>
        <label className={`${LABEL} sm:col-span-2`}>Original location<input name={rowField(0, 'keptAt')} defaultValue={record.kept_at} required className={`${FIELD} mt-1 block w-full`} /></label>
      </div>
    </ActionForm> : <div className="text-body">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-ink-secondary"><span className="tabular-nums">{record.on_date}</span> · {minuteKindLabel(record.record_kind)}</p>
        <button type="button" className={`${QUIET} shrink-0`} onClick={() => setEditing(true)}>Edit record</button>
      </div>
        {record.note && <p className="mt-2 whitespace-pre-wrap break-words">{record.note}</p>}
        {record.kept_at !== 'FigTree' && <p className="mt-2 text-metadata text-ink-muted">Original: {record.kept_at}</p>}
    </div>}
    <section>
      <h3 className="text-section-title font-semibold">Documents</h3>
      {record.papers.length ? <ul className="mt-2 divide-y divide-line-subtle">
        {record.papers.map(p => <li key={p.id} className="flex items-start justify-between gap-3 py-2">
          <div className="min-w-0 flex-1">
            <a href={`/ledger/${ledgerId}/records/minute-book/${p.id}`} target="_blank" rel="noopener" className="inline-flex min-h-control items-center break-words text-body underline underline-offset-2">{p.uploaded}</a>
            <p className="text-caption text-ink-muted">{minuteFileSize(p.byte_size)}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
          <a href={`/ledger/${ledgerId}/records/minute-book/${p.id}?download=1`} className={TOOL_BUTTON} title={`Download ${p.uploaded}`} aria-label={`Download ${p.uploaded}`}><Icon name="download" /></a>
          <Floating label="Remove" title={`Remove ${p.uploaded}`} ariaLabel={`Remove ${p.uploaded}`} buttonClassName={GHOST}>
            <ActionForm action={detachMinuteBookAction} submit="Remove attachment" working="Removing…" buttonClassName={DANGER} className="space-y-3">
              <input type="hidden" name={F.ledgerId} value={ledgerId} /><input type="hidden" name={F.paperId} value={p.id} />
              <label className={LABEL}>Reason<input name={F.reason} required maxLength={500} className={`${FIELD} mt-1 w-full`} /></label>
            </ActionForm>
          </Floating>
          </div>
        </li>)}
      </ul> : <p className="mt-2 text-body text-ink-muted">No documents attached. Choose files below.</p>}
    </section>
    <section className="border-t border-line-subtle pt-4">
      <MinuteBookUpload ledgerId={ledgerId} minuteId={record.id} today={today} kinds={kinds} />
    </section>
    <div className="border-t border-line-subtle pt-4">
      <Floating label="Delete record" title={`Delete ${record.title}`} buttonClassName={GHOST}>
        <p className="mb-4 text-body">Delete this record and its attachment links? The original files remain in the store.</p>
        <ActionForm action={deleteRecordRowAction} submit="Delete record" working="Deleting…" buttonClassName={DANGER}>{which}</ActionForm>
      </Floating>
    </div>
  </div>
}

export function MinuteBookScreen({ ledgerId, entity, today, kinds, records, initialQuery = '' }: {
  ledgerId: string; entity: string; today: string; kinds: string[]; records: MinuteRecordView[]; initialQuery?: string
}) {
  const [query, setQuery] = useState(initialQuery), [category, setCategory] = useState('')
  const [from, setFrom] = useState(''), [to, setTo] = useState(''), [page, setPage] = useState(0)
  const group = MINUTE_CATEGORIES.find(c => c.value === category)
  const q = query.trim().toLowerCase()
  const filtered = records.filter(r => (!group || (group.kinds as readonly string[]).includes(r.record_kind))
    && (!from || r.on_date >= from) && (!to || r.on_date <= to)
    && (!q || [r.title, r.note ?? '', r.kept_at, minuteKindLabel(r.record_kind), ...r.papers.map(p => p.uploaded)].some(s => s.toLowerCase().includes(q))))
  const perPage = 50, maxPage = Math.max(0, Math.ceil(filtered.length / perPage) - 1), current = Math.min(page, maxPage)
  const visible = filtered.slice(current * perPage, (current + 1) * perPage)
  const active = Boolean(query || category || from || to)
  const reset = () => { setQuery(''); setCategory(''); setFrom(''); setTo(''); setPage(0) }
  return <>
    <PageHeader title="Minute book" context={entity} backTo={`/ledger/${ledgerId}/records`} backLabel="Back to Corporate records">
      <Link href={`/ledger/${ledgerId}/records/add/minute_book`} className={GHOST}>Add record only</Link>
      <Floating label="Add documents" title="Add documents" buttonClassName={BUTTON}>
        <MinuteBookUpload ledgerId={ledgerId} today={today} kinds={kinds} />
      </Floating>
    </PageHeader>
    <FilterBar actions={<button type="button" className={`${GHOST} ${!active ? 'invisible' : ''}`} disabled={!active} onClick={reset}>Clear</button>}>
      <label className="min-w-48 flex-1"><span className="sr-only">Search documents</span>
        <input type="search" placeholder="Search title or filename" value={query} onChange={e => { setQuery(e.target.value); setPage(0) }} className={`${FIELD} w-full`} />
      </label>
      <label className="shrink-0"><span className="sr-only">Category filter</span><select aria-label="Category filter" value={category} onChange={e => { setCategory(e.target.value); setPage(0) }} className={`${FIELD} block w-48`}>
        <option value="">All categories</option>{MINUTE_CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
      </select></label>
      <label className="flex shrink-0 items-center gap-2 text-metadata text-ink-muted">From<DateInput aria-label="From date" value={from} onChange={e => { setFrom(e.target.value); setPage(0) }} className={`${FIELD} w-40`} /></label>
      <label className="flex shrink-0 items-center gap-2 text-metadata text-ink-muted">To<DateInput aria-label="To date" value={to} onChange={e => { setTo(e.target.value); setPage(0) }} className={`${FIELD} w-40`} /></label>
    </FilterBar>
    <TableViewport label="Minute book records">
      <DataTable className="ui-table-spaced min-w-2xl table-fixed">
        <thead><tr><th scope="col" className="w-32 whitespace-nowrap text-left">Date</th><th scope="col" className="text-left">Record</th><th scope="col" className="w-48 text-left">Category</th><th scope="col" className="w-16 text-right">Files</th></tr></thead>
        <tbody>{visible.map(r => <tr key={r.id}>
          <td data-date><span className="inline-flex min-h-control items-center">{r.on_date}</span></td>
          <td>
            <Floating label={r.title} title={r.title} ariaLabel={`Open ${r.title}`} buttonClassName={`${TABLE_ACTION} max-w-full break-words`}>
              <MinuteBookRecordPanel ledgerId={ledgerId} record={r} today={today} kinds={kinds} />
            </Floating>
            <p className="truncate text-metadata text-ink-muted" title={r.papers.map(p => p.uploaded).join(', ')}>
              {r.papers.length ? r.papers.map(p => p.uploaded).join(', ') : 'No attachments'}
            </p>
          </td>
          <td className="text-ink-secondary"><span className="inline-flex min-h-control items-center">{minuteKindLabel(r.record_kind)}</span></td>
          <td data-numeric><span className="inline-flex min-h-control items-center">{formatNumber(r.papers.length)}</span></td>
        </tr>)}</tbody>
      </DataTable>
      {!visible.length && <div className="py-10 text-center text-body text-ink-muted">
        {active ? 'No records match these filters.' : 'Add incorporation documents, resolutions or memos to get started.'}
      </div>}
    </TableViewport>
    <div className="mt-3 flex items-center justify-between gap-3 text-metadata text-ink-muted">
      <span>{formatNumber(filtered.length)} {filtered.length === 1 ? 'record' : 'records'}</span>
      {maxPage > 0 && <div className="flex items-center gap-2">
        <button type="button" className={QUIET} disabled={current === 0} onClick={() => setPage(current - 1)}>Previous</button>
        <span>{current + 1} / {maxPage + 1}</span>
        <button type="button" className={QUIET} disabled={current === maxPage} onClick={() => setPage(current + 1)}>Next</button>
      </div>}
    </div>
  </>
}
