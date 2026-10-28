'use client'

import { formatNumber } from '@/lib/numbers'
import { useState } from 'react'
import Link from 'next/link'
import { ActionForm, type FormAction } from '@/components/ActionForm'
import { RECORD_FIELDS as F } from '@/lib/forms'
import { DateInput } from '@/components/DateInput'
import { BUTTON, FIELD, QUIET, QUIET_COMPACT, TABLE_ACTION } from '@/lib/ui'
import { DataTable, TableViewport } from '@/components/Table'
import { minuteKindLabel } from '@/lib/minute-book'
import type { RecordTable } from '@/lib/record-rows'
import { RowEditor, type RecordChoices } from './RowEditor'
import { ShareholderAddress } from './ShareholderAddress'
import type { ShareholderAddress as Address } from '@/lib/shareholder-address'

export type Choice = { id: string; label: string }

const TH = 'py-1 pr-3 text-xs uppercase tracking-wide text-neutral-500'
const TD = 'py-2 pr-3 align-top'
const ROW = 'border-b border-neutral-200 last:border-0 dark:border-neutral-800'

function Section({ title, add, children }: {
  title: string; blurb: string
  /** The button that opens this section's add form, floated over the page. */
  add?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-section-title font-semibold text-ink">{title}</h2>
        {add}
      </div>

      {children}
    </section>
  )
}

const Empty = ({ what }: { what: string }) => (
  <p className="mt-3 text-sm text-neutral-500">No {what} yet.</p>
)

/**
 * Ending somebody's term: a quiet button, and the date only once it is pressed.
 * A date box in every row of a register was a blank in every row (owner,
 * 2026-09-16: 「不要再像 corporate records 一样，直接有空可以填」).
 */
function Cease({ action, ledgerId, idField, id, today, who }: {
  action: FormAction; ledgerId: string; idField: string; id: string; today: string; who: string
}) {
  const [open, setOpen] = useState(false)
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={QUIET} aria-label={`Cease ${who}`}>
        Cease…
      </button>
    )
  }
  return (
    <div className="flex items-end justify-end gap-2">
      <ActionForm action={action} submit="Cease" working="…"
                  className="flex items-end justify-end gap-2" buttonClassName={QUIET}>
        <input type="hidden" name={F.ledgerId} value={ledgerId} />
        <input type="hidden" name={idField} value={id} />
        <DateInput name={F.ceasedOn} defaultValue={today} required aria-label={`Date ${who} ceased`}
                   className={`${FIELD} py-1 text-xs`} />
      </ActionForm>
      <button type="button" onClick={() => setOpen(false)} className="text-xs text-neutral-500 hover:underline">
        Cancel
      </button>
    </div>
  )
}

/** A share class renamed in place, or deleted while nothing on the register is in it (0083). */
function ClassEditor({ ledgerId, c, rename, remove, onClose }: {
  ledgerId: string; c: ShareClassRow; rename: FormAction; remove: FormAction; onClose: () => void
}) {
  const which = (
    <>
      <input type="hidden" name={F.ledgerId} value={ledgerId} />
      <input type="hidden" name={F.shareClassId} value={c.id} />
    </>
  )
  return (
    <div data-editing={c.id} className="flex flex-wrap items-end gap-3">
      <ActionForm action={rename} submit="Save" working="Saving…" onSucceeded={onClose}
                  className="flex flex-wrap items-end gap-3" buttonClassName={QUIET}>
        {which}
        <label className="flex flex-col gap-0.5 text-[11px] text-neutral-500">
          Class *
          <input name={F.className} required defaultValue={c.name} className={`${FIELD} w-40 py-1 text-xs`} />
        </label>
        <label className="flex flex-col gap-0.5 text-[11px] text-neutral-500">
          Series
          <input name={F.series} defaultValue={c.series ?? ''} className={`${FIELD} w-32 py-1 text-xs`} />
        </label>
      </ActionForm>
      {c.movements === 0 && (
        <ActionForm action={remove} submit="Delete" working="Deleting…" onSucceeded={onClose}
                    className="inline" buttonClassName={`${QUIET} text-red-700 dark:text-red-400`}>
          {which}
        </ActionForm>
      )}
      <button type="button" onClick={onClose} className="text-xs text-neutral-500 hover:underline">Cancel</button>
    </div>
  )
}

export type MovementRow = {
  id: string; kind: string; share_class: string; on_date: string
  from_name: string; to_name: string; quantity: string; consideration: string
  certificate_no: string; surrendered_no: string; balance_no: string; details: string
}
export type ShareClassRow = { id: string; name: string; series: string | null; movements: number }

/**
 * The corporate-records screen: what the company must keep.
 *
 * Every section is a table of what is on file and an Add button. The button
 * opens that table's add form in a floating page (`records/add/[table]`), a
 * form of ROWS, which is also where a reading of a minute book lands — so what
 * a person types and what a model read go into the same form, through the same
 * door (docs/design/41).
 *
 * Every row can be put right or taken out (owner, 2026-09-16: 「所有的紀錄儘量都
 * 可以編輯刪除」, 0083): its Edit opens the add form's own boxes on the row, with
 * Save, Delete and Cancel. Ceasing stays a date for something that happened;
 * Edit is for what was entered wrong. Nothing is a box until one is pressed.
 * What each table shows is the FULL history; "as at" questions belong to the
 * register pages, which render from the one renderer.
 */
export type RecordsShow = 'all' | 'basic' | 'directors' | 'securities' | 'transparency'

export function RecordsScreen({
  ledgerId, today, profile, isCcpc, companyTypes, offices, directorships,
  holdings, totals, sis, minuteBook, minutePaper = {}, movements = [], classes = [], choices,
  actions, show = 'all', initialEditing = null,
}: {
  /** Which domains to render: the Basic Info page keeps profile/offices/
   *  minute book; each register page renders ITS section under the register
   *  itself (owner, 2026-09-03). One definition, gated. */
  show?: RecordsShow
  ledgerId: string
  today: string
  profile: { incorporation_number: string | null; business_number: string | null
             recognition_date: string | null; company_type: string } | null
  /** Three-state: true, false, or nobody has said — see RECORD_FIELDS.isCcpc. */
  isCcpc: boolean | null
  companyTypes: Choice[]
  offices: Array<{ id: string; office: string; delivery_address: string; delivery_city: string
                   delivery_postal: string | null; effective_from: string; effective_to: string | null }>
  directorships: Array<{ id: string; name: string; prescribed_delivery: string
                         appointed_on: string; ceased_on: string | null }>
  holdings: Array<{
    share_class_id: string; party_id: string
    class_name: string; series: string | null; holder: string; holding: string
    address?: string | null; addressDetails?: Address
  }>
  totals: Array<{ class_name: string; series: string | null; issued: string }>
  sis: Array<{ id: string; name: string; how_control: string; became_on: string; ceased_on: string | null;
               citizen_or_pr: boolean; citizenships: string | null; tax_resident_ca: boolean }>
  minuteBook: Array<{ id: string; record_kind: string; on_date: string
                      title: string; kept_at: string; note?: string | null }>
  /** Each record's documents, by record id (0081). */
  minutePaper?: Record<string, Array<{ id: string; filename: string }>>
  /** Every movement on the securities register, a transfer once (0083). */
  movements?: MovementRow[]
  classes?: ShareClassRow[]
  /** What an Edit's boxes suggest; without it, and the two doors, no row offers Edit. */
  choices?: RecordChoices
  actions: {
    cease: FormAction; ceaseSi: FormAction
    attachMinute?: FormAction; detachMinute?: FormAction
    correct?: FormAction; remove?: FormAction
    renameClass?: FormAction; deleteClass?: FormAction
    setShareholderAddress?: FormAction
  }
  /** Which row's Edit starts pressed — `<DataTable density="reading">:<id>` — for the render harness. */
  initialEditing?: string | null
}) {
  const [editing, setEditing] = useState<string | null>(initialEditing)
  const add = (table: RecordTable, label: string) => (
    <Link href={`/ledger/${ledgerId}/records/add/${table}`} className={BUTTON} data-add={table}>{label}</Link>
  )
  const typeLabel = companyTypes.find((t) => t.id === profile?.company_type)?.label ?? profile?.company_type
  const canEdit = Boolean(actions.correct && actions.remove && choices)

  /** The row's Edit — or nothing, on a screen that was not handed the doors. */
  const edit = (table: RecordTable | 'class', id: string, what: string, className = QUIET) => canEdit && (
    <button type="button" onClick={() => setEditing(`${table}:${id}`)} className={className} aria-label={`Edit ${what}`}>
      Edit
    </button>
  )
  const copy = (table: RecordTable, id: string, className = `${QUIET} mr-2`) => (
    <Link href={`/ledger/${ledgerId}/records/add/${table}?copy=${id}`}
          className={className}>Copy</Link>
  )
  const isEditing = (table: RecordTable | 'class', id: string) => canEdit && editing === `${table}:${id}`
  /** A row opened for editing: the whole width, the add form's boxes holding what is on file. */
  const editorRow = (table: RecordTable, id: string, span: number, initial: Record<string, string>,
                     extra: { blankMeansKeep?: string[]; removeNote?: string } = {}) => (
    <tr key={id} className={`${ROW} bg-neutral-50 dark:bg-neutral-950`}>
      <td colSpan={span} className="px-2 py-3">
        <RowEditor ledgerId={ledgerId} table={table} recordId={id} initial={initial} choices={choices!}
                   correct={actions.correct!} remove={actions.remove!} onClose={() => setEditing(null)} {...extra} />
      </td>
    </tr>
  )

  return (
    <>
      {(show === 'all' || show === 'basic') && (
      <Section title="Profile" blurb="The company as the registry knows it. The recognition date is the root both annual deadlines grow from."
               add={<Link href={`/ledger/${ledgerId}/records/profile`} className={QUIET}>Edit profile</Link>}>
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
          <dt className="text-neutral-500">Incorporation no.</dt><dd>{profile?.incorporation_number ?? '—'}</dd>
          <dt className="text-neutral-500">Business no.</dt><dd>{profile?.business_number ?? '—'}</dd>
          <dt className="text-neutral-500">Recognition date</dt><dd>{profile?.recognition_date ?? '—'}</dd>
          <dt className="text-neutral-500">Type</dt><dd>{typeLabel ?? '—'}</dd>
          <dt className="text-neutral-500">CCPC</dt>
          <dd>{isCcpc === null ? 'Nobody has said' : isCcpc ? 'Yes' : 'No'}</dd>
        </dl>
      </Section>
      )}

      {(show === 'all' || show === 'basic') && (
      <Section title="Offices" blurb="Registered and records offices, both required to be in BC — the database refuses anything else. A new address ends the one before it the day before; deleting an address gives its days back to the one before."
               add={add('offices', 'Add an office')}>
        {offices.length > 0 ? (
          <DataTable density="reading" className="mt-3 w-full text-sm"><tbody>
            <tr className={ROW}><td className={TH}>Office</td><td className={TH}>Delivery address</td><td className={TH}>Since</td><td className={TH}>Until</td><td className={TH} /></tr>
            {offices.map((o) => isEditing('offices', o.id)
              ? editorRow('offices', o.id, 5, {
                  office: o.office, deliveryAddress: o.delivery_address, deliveryCity: o.delivery_city,
                  deliveryPostal: o.delivery_postal ?? '', effectiveFrom: o.effective_from,
                })
              : (
              <tr key={o.id} className={ROW} data-office={o.id}>
                <td className={TD}>{o.office}</td>
                <td className={TD}>{o.delivery_address}, {o.delivery_city} {o.delivery_postal}</td>
                <td className={TD}>{o.effective_from}</td>
                <td className={TD}>{o.effective_to ?? '—'}</td>
                <td className={`${TD} text-right`}>{copy('offices', o.id)}{edit('offices', o.id, `the ${o.office} office from ${o.effective_from}`)}</td>
              </tr>
            ))}
          </tbody></DataTable>
        ) : <Empty what="offices on file" />}
      </Section>
      )}

      {(show === 'all' || show === 'directors') && (
      <Section title="Directors" blurb="Every term ever held — a former director keeps their dates, because the register's job is answering who was a director as at any day. The prescribed address freezes on the row. Cease is for a director who left; Edit is for a row entered wrong."
               add={add('directors', 'Add directors')}>
        {directorships.length > 0 ? (
          <DataTable density="reading" className="mt-3 w-full text-sm"><tbody>
            <tr className={ROW}><td className={TH}>Name</td><td className={TH}>Prescribed address</td><td className={TH}>Appointed</td><td className={TH}>Ceased</td><td className={TH} /></tr>
            {directorships.map((d) => isEditing('directors', d.id)
              ? editorRow('directors', d.id, 5, {
                  name: d.name, address: d.prescribed_delivery, appointedOn: d.appointed_on, ceasedOn: d.ceased_on ?? '',
                })
              : (
              <tr key={d.id} className={ROW}>
                <td className={TD}>{d.name}</td>
                <td className={TD}>{d.prescribed_delivery}</td>
                <td className={TD}>{d.appointed_on}</td>
                <td className={TD}>{d.ceased_on ?? '—'}</td>
                <td className={`${TD} text-right`}>
                  <span className="flex items-start justify-end gap-3">
                    {!d.ceased_on && (
                      <Cease action={actions.cease} ledgerId={ledgerId} idField={F.directorshipId} id={d.id}
                             today={today} who={d.name} />
                    )}
                    {copy('directors', d.id)}
                    {edit('directors', d.id, `${d.name}'s term from ${d.appointed_on}`)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody></DataTable>
        ) : <Empty what="directors" />}
      </Section>
      )}

      {(show === 'all' || show === 'securities') && (
      <Section title="Central securities register" blurb="Issues, transfers and cancellations, and the holdings they add up to today — derived from the movements, stored nowhere. A transfer is two rows netting to zero. A movement entered wrong can be put right or deleted; nobody's holding may go negative on any day, and the audit trail keeps what it said before."
               add={add('shares', 'Add share movements')}>
        {holdings.length > 0 ? (
          <div className="mt-3 overflow-x-auto"><DataTable density="reading" className="w-full text-sm"><tbody>
            <tr className={ROW}><td className={TH}>Class</td><td className={TH}>Holder</td><td className={TH}>Last known address</td><td className={`${TH} text-right`}>Held today</td><td className={TH} /></tr>
            {holdings.map((h, i) => (
              <tr key={i} className={ROW}>
                <td className={TD}>{h.series ? `${h.class_name} — ${h.series}` : h.class_name}</td>
                <td className={TD}>{h.holder}</td>
                <td className={`${TD} min-w-48`}>
                  <span className="block">{h.address || '—'}</span>
                  {actions.setShareholderAddress && (
                    <ShareholderAddress key={`${h.party_id}:${h.address ?? ''}`} ledgerId={ledgerId}
                      partyId={h.party_id} holder={h.holder} address={h.addressDetails}
                      action={actions.setShareholderAddress} />
                  )}
                </td>
                <td className={`${TD} text-right font-mono tabular-nums`}>{formatNumber(h.holding)}</td>
                {/* The paper the shareholder keeps. One certificate is this
                    holder's whole holding of this class (owner, 2026-09-03),
                    which is why it hangs off the holding rather than off a
                    movement. */}
                <td className={`${TD} text-right`}>
                  {BigInt(h.holding) > 0n && <a href={`/ledger/${ledgerId}/records/certificate/pdf?class=${h.share_class_id}&party=${h.party_id}`}
                     target="_blank" className="text-xs underline hover:no-underline">
                    Certificate
                  </a>}
                </td>
              </tr>
            ))}
            {totals.map((t, i) => (
              <tr key={`t${i}`} className={ROW}>
                <td className={TD}>{t.series ? `${t.class_name} — ${t.series}` : t.class_name}</td>
                <td className={`${TD} font-semibold`}>TOTAL ISSUED</td>
                <td className={TD} />
                <td className={`${TD} text-right font-mono font-semibold tabular-nums`}>{formatNumber(t.issued)}</td>
                <td className={TD} />
              </tr>
            ))}
          </tbody></DataTable></div>
        ) : <Empty what="shares held today" />}

        {movements.length > 0 && (
          <>
            <h3 className="mt-6 text-xs font-semibold uppercase tracking-wide text-neutral-500">Movements</h3>
            <DataTable density="reading" className="mt-2 w-full text-sm"><tbody>
              <tr className={ROW}>
                <td className={TH}>On</td><td className={TH}>What</td><td className={TH}>Class</td><td className={TH}>From</td>
                <td className={TH}>To</td><td className={`${TH} text-right`}>Shares</td><td className={TH}>Details</td><td className={TH} />
              </tr>
              {movements.map((m) => isEditing('shares', m.id)
                ? editorRow('shares', m.id, 8, {
                    kind: m.kind, shareClass: m.share_class, onDate: m.on_date, from: m.from_name, to: m.to_name,
                    quantity: m.quantity, consideration: m.consideration, certificateNo: m.certificate_no,
                    surrenderedNo: m.surrendered_no, balanceNo: m.balance_no, details: m.details,
                  }, { removeNote: m.kind === 'transfer' ? 'Both sides of the transfer go.' : undefined })
                : (
                <tr key={m.id} className={ROW} data-movement={m.id}>
                  <td className={`${TD} font-mono text-xs`}>{m.on_date}</td>
                  <td className={TD}>{m.kind}</td>
                  <td className={TD}>{m.share_class}</td>
                  <td className={TD}>{m.from_name || '—'}</td>
                  <td className={TD}>{m.to_name || '—'}</td>
                  <td className={`${TD} text-right font-mono tabular-nums`}>{formatNumber(m.quantity)}</td>
                  <td className={`${TD} text-xs text-neutral-500`}>{m.details}</td>
                  <td className={`${TD} text-right`}>{copy('shares', m.id)}{edit('shares', m.id, `the ${m.kind} of ${m.on_date}`)}</td>
                </tr>
              ))}
            </tbody></DataTable>
          </>
        )}

        {classes.length > 0 && (
          <>
            <h3 className="mt-6 text-xs font-semibold uppercase tracking-wide text-neutral-500">Classes</h3>
            <DataTable density="reading" className="mt-2 w-full text-sm"><tbody>
              {classes.map((c) => (
                <tr key={c.id} className={ROW}>
                  {isEditing('class', c.id) && actions.renameClass && actions.deleteClass ? (
                    <td colSpan={3} className="px-2 py-3">
                      <ClassEditor ledgerId={ledgerId} c={c} rename={actions.renameClass} remove={actions.deleteClass}
                                   onClose={() => setEditing(null)} />
                    </td>
                  ) : (
                    <>
                      <td className={TD}>{c.series ? `${c.name} — ${c.series}` : c.name}</td>
                      <td className={`${TD} text-xs text-neutral-500`}>
                        {c.movements === 0 ? 'nothing on the register' : `${c.movements} movement${c.movements === 1 ? '' : 's'}`}
                      </td>
                      <td className={`${TD} text-right`}>
                        {actions.renameClass && actions.deleteClass && edit('class', c.id, `the class ${c.name}`)}
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody></DataTable>
          </>
        )}
      </Section>
      )}

      {(show === 'all' || show === 'transparency') && (
      <Section title="Significant individuals" blurb="Current and former significant individuals. In Edit, blank birth date and address keep the values on file."
               add={add('transparency', 'Add significant individuals')}>
        {sis.length > 0 ? (
          <DataTable density="reading" className="mt-3 w-full text-sm"><tbody>
            <tr className={ROW}><td className={TH}>Name</td><td className={TH}>How</td><td className={TH}>Since</td><td className={TH}>Ceased</td><td className={TH} /></tr>
            {sis.map((s) => isEditing('transparency', s.id)
              ? editorRow('transparency', s.id, 5, {
                  name: s.name, howControl: s.how_control, becameOn: s.became_on, ceasedOn: s.ceased_on ?? '',
                  birthDate: '', lastKnownAddress: '',
                  citizenOrPr: s.citizen_or_pr ? 'yes' : 'no', citizenships: s.citizenships ?? '',
                  taxResidentCa: s.tax_resident_ca ? 'yes' : 'no',
                }, { blankMeansKeep: ['birthDate', 'lastKnownAddress'] })
              : (
              <tr key={s.id} className={ROW}>
                <td className={TD}>{s.name}</td>
                <td className={TD}>{s.how_control}</td>
                <td className={TD}>{s.became_on}</td>
                <td className={TD}>{s.ceased_on ?? '—'}</td>
                <td className={`${TD} text-right`}>
                  <span className="flex items-start justify-end gap-3">
                    {!s.ceased_on && (
                      <Cease action={actions.ceaseSi} ledgerId={ledgerId} idField={F.siId} id={s.id}
                             today={today} who={s.name} />
                    )}
                    {copy('transparency', s.id)}
                    {edit('transparency', s.id, `${s.name}'s entry from ${s.became_on}`)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody></DataTable>
        ) : <Empty what="significant individuals" />}
      </Section>
      )}

      {(show === 'all' || show === 'basic') && (
      <Section title="Minute book" blurb="Where the paper lives. The database holds that a record exists, what kind, when, and where it is kept — the text stays a document."
               add={<span className="flex items-center gap-2"><Link href={`/ledger/${ledgerId}/records/minute-book`} className={QUIET}>Open minute book</Link>{add('minute_book', 'Add record')}</span>}>
        {minuteBook.length > 0 ? (
          <TableViewport label="Minute book records" className="mt-3">
          <DataTable density="reading" className="ui-table-spaced min-w-5xl table-fixed">
            <thead><tr>
              <th scope="col" className="w-32 text-left">Date</th>
              <th scope="col" className="w-44 text-left">Kind</th>
              <th scope="col" className="text-left">Title</th>
              <th scope="col" className="w-32 text-left">Kept at</th>
              <th scope="col" className="text-left">Documents</th>
              <th scope="col" className="relative w-32 text-right"><span className="sr-only">Actions</span></th>
            </tr></thead><tbody>
            {minuteBook.map((m) => {
              const paper = minutePaper[m.id] ?? []
              if (isEditing('minute_book', m.id)) {
                return editorRow('minute_book', m.id, 6, {
                  recordKind: m.record_kind, onDate: m.on_date, title: m.title, keptAt: m.kept_at, note: m.note ?? '',
                }, {
                  removeNote: paper.length
                    ? `Its ${paper.length === 1 ? 'document is' : `${formatNumber(paper.length)} documents are`} unfiled with it; the files stay in the store.`
                    : undefined,
                })
              }
              return (
              <tr key={m.id} data-minute-record={m.id}>
                <td data-date><span className="inline-flex min-h-control items-center">{m.on_date}</span></td>
                <td className="text-ink-secondary"><span className="inline-flex min-h-control items-center">{minuteKindLabel(m.record_kind)}</span></td>
                <td><span className="inline-flex min-h-control items-center break-words">{m.title}</span></td>
                <td><span className="inline-flex min-h-control items-center break-words">{m.kept_at}</span></td>
                <td data-minute-paper={m.id}>
                  <Link href={`/ledger/${ledgerId}/records/minute-book?q=${encodeURIComponent(m.title)}`}
                        className={`${TABLE_ACTION} max-w-full`}>Manage documents</Link>
                  <div className="min-w-0">
                    {paper.map((p) => (
                      <a key={p.id} href={`/ledger/${ledgerId}/records/minute-book/${p.id}`} target="_blank"
                         rel="noopener" title={p.filename} className="block truncate text-metadata text-ink-muted underline underline-offset-2">{p.filename}</a>
                    ))}
                    {!paper.length && <p className="text-metadata text-ink-muted">No attachments</p>}
                  </div>
                </td>
                <td><div className="flex flex-nowrap items-center justify-end gap-2">
                  {copy('minute_book', m.id, QUIET_COMPACT)}{edit('minute_book', m.id, `the record ${m.title}`, QUIET_COMPACT)}
                </div></td>
              </tr>
              )
            })}
          </tbody></DataTable>
          </TableViewport>
        ) : <Empty what="minute-book records" />}
      </Section>
      )}

      {(show === 'all' || show === 'basic') && (
      <p className="mt-10 text-xs text-neutral-500">
        Registers, rendered as at a date:{' '}
        <Link className="underline" href={`/ledger/${ledgerId}/records/register/directors`}>directors</Link>{' · '}
        <Link className="underline" href={`/ledger/${ledgerId}/records/register/central_securities`}>central securities</Link>{' · '}
        <Link className="underline" href={`/ledger/${ledgerId}/records/register/transparency`}>transparency</Link>
      </p>
      )}
    </>
  )
}
