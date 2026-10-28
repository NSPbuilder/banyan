import { DateInput } from '@/components/DateInput'
import Link from 'next/link'
import { Picker } from '@/components/Picker'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { requireLedger } from '@/lib/gate'
import { refuseForLedger } from '@/lib/access'
import { fxContext, fxCurrencies, fxPositions } from '@/lib/fx'
import { formatNative, fxDate, type FxSnapshot } from '@/lib/fx-money'
import { formatMoney } from '@/lib/money'
import { ActionForm } from '@/components/ActionForm'
import { PageHeader } from '@/components/PageHeader'
import { FIELD, QUIET, CARD } from '@/lib/ui'
import { FxDocumentForm } from './FxDocumentForm'
import { fxAction } from './actions'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Currencies & FX' }

function Hidden({ ledgerId, op }: { ledgerId: string; op: string }) {
  return <><input type="hidden" name="ledgerId" value={ledgerId}/><input type="hidden" name="op" value={op}/><input type="hidden" name="requestKey" value={randomUUID()}/></>
}

function RateFields({ prefix = '', currency = 'foreign currency' }: { prefix?: string; currency?: string }) {
  return <div className="grid gap-3 sm:grid-cols-3">
    <label>CAD per 1 {currency}<input name={prefix+'rate'} inputMode="decimal" className={`${FIELD} mt-1 w-full`}/></label>
    <label>Rate date<DateInput  name={prefix+'rateDate'} className={`${FIELD} mt-1 w-full`}/></label>
    <label>Rate evidence<input name={prefix+'rateEvidence'} placeholder="Bank advice or source reference" className={`${FIELD} mt-1 w-full`}/></label>
  </div>
}

export default async function ForeignCurrency({ params, searchParams }: PageProps<'/ledger/[ledgerId]/fx'>) {
  const { ledgerId } = await params, user = await requireLedger(ledgerId, '/entries'), q = await searchParams
  const today = new Date().toLocaleDateString('en-CA')
  let date = typeof q.date === 'string' ? q.date : today
  try { fxDate(date) } catch { date = today }
  const context = await fxContext(ledgerId), currencies = await fxCurrencies(ledgerId)
  const mayInvoice = !(await refuseForLedger(user, ledgerId, '/invoices')), mayBank = !(await refuseForLedger(user, ledgerId, '/bank'))
  const [accounts, parties, documents, entries, allPositions] = await Promise.all([
    db.execute<{ id: string; code: string; name: string; account_type: string; currency: string; roles: string[] }>(sql`
      SELECT a.id::text,a.code,a.name,a.account_type,COALESCE(a.foreign_currency,'CAD') AS currency,
        ARRAY(SELECT role FROM account_role WHERE account_id=a.id) AS roles
      FROM account a WHERE a.entity_id=${context.entity_id}::uuid AND a.is_active AND a.is_postable ORDER BY a.code`),
    mayInvoice ? db.execute<{ id: string; name: string; roles: string[] }>(sql`SELECT p.id::text,p.name,
      ARRAY(SELECT role FROM party_role WHERE party_id=p.id AND entity_id=${context.entity_id}::uuid) AS roles
      FROM party p WHERE p.is_active AND EXISTS(SELECT 1 FROM party_role WHERE party_id=p.id AND entity_id=${context.entity_id}::uuid) ORDER BY p.name`) : [],
    mayInvoice ? db.execute<{ id: string; number: string | null; direction: string; document_kind: string; status: string; currency: string; issued_on: string; party: string; native_total: bigint; native_balance: bigint; carrying_balance: bigint; snapshot: FxSnapshot }>(sql`
      SELECT i.id::text,i.number,i.direction,i.document_kind,i.status,i.fx_currency AS currency,i.issued_on::text,p.name AS party,
        abs((SELECT sum(original_amount) FROM invoice_line WHERE invoice_id=i.id))::bigint AS native_total,
        abs(pos.native_balance)::bigint AS native_balance,abs(pos.carrying_balance)::bigint AS carrying_balance,i.fx_snapshot AS snapshot
      FROM invoice i JOIN party p ON p.id=i.party_id CROSS JOIN LATERAL fx_invoice_at(i.id) pos
      WHERE i.ledger_id=${ledgerId}::uuid AND i.fx_currency IS NOT NULL ORDER BY i.issued_on DESC,i.created_at DESC LIMIT 200`) : [],
    db.execute<{ id: string; entry_no: string; source_type: string; entry_date: string }>(sql`SELECT e.id::text,e.entry_no,e.source_type,e.entry_date::text FROM journal_entry e
      WHERE e.ledger_id=${ledgerId}::uuid AND e.status='posted' AND e.reverses_id IS NULL
        AND e.source_type IN ('payment','fx_revaluation','fx_transfer','bank','manual','opening_balance')
        AND EXISTS(SELECT 1 FROM journal_line WHERE entry_id=e.id AND original_currency IS NOT NULL)
      ORDER BY e.created_at DESC LIMIT 100`),
    fxPositions(ledgerId, date),
  ])
  const positions = allPositions.filter(p => p.kind === 'invoice' ? mayInvoice : mayBank)
  const banks = accounts.filter(a => a.roles.includes('cash_and_cash_equivalents'))
  const enabled = currencies.filter(c => c.enabled && c.code !== 'CAD').map(c => c.code)
  const configured = currencies.filter(c => c.code === 'CAD' || c.configured)
  const open = documents.filter(d => d.status === 'posted' && d.native_balance > 0n)
  const invoices = open.filter(d => d.document_kind === 'invoice'), credits = open.filter(d => d.document_kind === 'credit_note')
  const owner = user.is_owner && !context.archived_at
  const label = (d: typeof documents[number]) => `${d.number ?? 'Foreign document'} · ${d.party} · ${d.currency} ${formatNative(d.native_balance,d.currency)}`
  const bankOptions = banks.map(a => ({id:a.id,label:`${a.code} ${a.name} (${a.currency})`}))
  const feeOptions = accounts.filter(a => a.account_type === 'expense').map(a => ({id:a.id,label:`${a.code} ${a.name}`}))

  return <main className="space-y-6">
    <PageHeader title="Currencies & FX" backTo={`/ledger/${ledgerId}/entries`} backLabel="Journal entries"/>
    <p className="text-body text-ink-secondary">Functional currency: CAD. Stop new business in a currency whenever needed; its existing documents, balances and rate history remain available.</p>

    <section className={CARD} aria-labelledby="fx-currencies">
      <h2 id="fx-currencies" className="text-section-title font-semibold">Available currencies</h2>
      <div className="mt-3 overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th className="p-2">Currency</th><th className="p-2">New business</th><th className="p-2">Latest saved BOC quote</th><th className="p-2">Action</th></tr></thead><tbody>
        {configured.map(c=><tr key={c.code} className="border-t border-line-subtle"><td className="p-2 font-medium">{c.code}{c.historical&&<span className="ml-2 text-xs text-ink-secondary">Historical series</span>}</td><td className="p-2">{c.code==='CAD'?'Always available':c.enabled?'Enabled':'Stopped'}</td><td className="p-2 tabular-nums">{c.code==='CAD'?'1':c.rate?`${c.rate} CAD · ${c.observed_on}`:'No saved quote'}</td><td className="p-2">{owner&&c.code!=='CAD'&&<ActionForm action={fxAction} submit={c.enabled?'Stop new business':'Re-enable'} buttonClassName={QUIET} working="Saving…"><Hidden ledgerId={ledgerId} op="currency"/><input type="hidden" name="currency" value={c.code}/><input type="hidden" name="enabled" value={String(!c.enabled)}/></ActionForm>}</td></tr>)}
      </tbody></table></div>
      {owner?<ActionForm action={fxAction} submit="Enable currency" className="mt-4 flex flex-wrap items-end gap-3" working="Saving…" buttonClassName={QUIET}><Hidden ledgerId={ledgerId} op="currency"/><input type="hidden" name="enabled" value="true"/><label>Add a BOC currency<select name="currency" required className={`${FIELD} ml-2`}><option value="">Choose currency</option>{currencies.filter(c=>c.code!=='CAD'&&!c.enabled).map(c=><option key={c.code} value={c.code}>{c.code}{c.historical?' (historical)':''}</option>)}</select></label></ActionForm>:<p className="mt-3 text-sm text-ink-secondary">An owner manages available currencies and bank currency bindings.</p>}
      <ActionForm action={fxAction} submit="Fetch BOC rates" className="mt-5 flex flex-wrap items-end gap-3" working="Saving…" buttonClassName={QUIET}><Hidden ledgerId={ledgerId} op="rates"/><label>Reference date<DateInput name="date"  required defaultValue={date} className={`${FIELD} ml-2`}/></label></ActionForm>
      <p className="mt-2 text-sm text-ink-secondary">BOC provides indicative daily averages. The latest quote on or before a transaction date can be used for up to seven days. Missing and discontinued quotes require an evidenced manual rate; posted rates never update automatically.</p>
    </section>

    <section className={CARD} aria-labelledby="fx-balances">
      <div className="flex flex-wrap items-end justify-between gap-3"><h2 id="fx-balances" className="text-section-title font-semibold">Original balances & CAD carrying value</h2><form className="flex flex-wrap gap-2"><label>As of<DateInput  name="date" required defaultValue={date} className={`${FIELD} ml-2`}/></label><button className={QUIET}>View</button></form></div>
      <div className="mt-3 overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th className="p-2">Position</th><th className="p-2">Currency</th><th className="p-2 text-right">Original balance</th><th className="p-2 text-right">CAD carrying value</th></tr></thead><tbody>{positions.map(p=><tr key={p.kind+p.id} className="border-t border-line-subtle"><td className="p-2"><Link href={p.kind==='invoice'?`/ledger/${ledgerId}/invoices/${p.id}`:`/ledger/${ledgerId}/bank/${p.id}`} className="hover:underline">{p.label}</Link></td><td className="p-2">{p.currency}</td><td className="p-2 text-right font-mono">{formatNative(p.native,p.currency)}</td><td className="p-2 text-right font-mono">{formatMoney(p.carrying)}</td></tr>)}</tbody></table></div>
      {!positions.length&&<p className="mt-3 text-sm text-ink-secondary">No open foreign monetary balances as of {date}.</p>}
    </section>

    {mayInvoice&&<details className={CARD} open data-fx-section="document"><summary className="cursor-pointer text-section-title font-semibold">New foreign invoice, bill or credit note</summary>{enabled.length?<FxDocumentForm ledgerId={ledgerId} currencies={enabled} accounts={accounts} parties={parties} date={date} requestKey={randomUUID()} action={fxAction}/>:<p className="mt-3 text-sm text-ink-secondary">Enable a foreign currency to create a document. CAD documents use the ordinary invoice and bill forms.</p>}</details>}

    {mayInvoice&&mayBank&&<details className={CARD} data-fx-section="payment"><summary className="cursor-pointer text-section-title font-semibold">Settle an existing document / refund a credit note</summary><ActionForm action={fxAction} submit="Record foreign settlement" className="mt-4 space-y-4" working="Saving…" buttonClassName={QUIET}><Hidden ledgerId={ledgerId} op="payment"/>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"><label>Document<Picker name="invoiceId" required ariaLabel="Settlement document" className="mt-1 w-full" defaultValue={typeof q.invoice==='string'?q.invoice:''} options={open.map(d=>({id:d.id,label:label(d)}))}/></label><label>Amount to settle (document currency)<input name="nativeAmount" inputMode="decimal" required className={`${FIELD} mt-1 w-full`}/></label><label>Settlement date<DateInput  name="date" required defaultValue={date} className={`${FIELD} mt-1 w-full`}/></label><label>Bank account<Picker name="bankAccountId" required ariaLabel="Bank account" className="mt-1 w-full" options={bankOptions}/></label><label>Actual cash before fees (bank currency)<input name="bankAmount" inputMode="decimal" className={`${FIELD} mt-1 w-full`} placeholder="Optional for same-currency bank"/></label><label>Bank advice / reference<input name="reference" className={`${FIELD} mt-1 w-full`}/></label><label>Fee (bank currency)<input name="fee" inputMode="decimal" className={`${FIELD} mt-1 w-full`}/></label><label>Fee expense account<Picker name="feeAccountId" ariaLabel="Fee expense account" className="mt-1 w-full" options={feeOptions}/></label></div>
      <details><summary className="cursor-pointer text-sm">Actual rate evidence (optional when actual CAD cash is entered)</summary><RateFields currency="document currency"/><div className="mt-3"><RateFields prefix="bank_" currency="other bank currency"/></div></details>
    </ActionForm></details>}

    {mayInvoice&&<details className={CARD}><summary className="cursor-pointer text-section-title font-semibold">Apply a foreign credit note</summary><ActionForm action={fxAction} submit="Apply foreign credit" className="mt-4 grid gap-3 sm:grid-cols-2" working="Saving…" buttonClassName={QUIET}><Hidden ledgerId={ledgerId} op="credit"/><label>Invoice / bill<Picker name="invoiceId" required ariaLabel="Invoice for credit application" className="mt-1 w-full" options={invoices.map(d=>({id:d.id,label:label(d)}))}/></label><label>Credit note<Picker name="creditId" required ariaLabel="Credit note" className="mt-1 w-full" options={credits.map(d=>({id:d.id,label:label(d)}))}/></label><label>Original amount<input name="nativeAmount" inputMode="decimal" required className={`${FIELD} mt-1 w-full`}/></label><label>Application date<DateInput  name="date" required defaultValue={date} className={`${FIELD} mt-1 w-full`}/></label></ActionForm></details>}

    {mayBank&&<details className={CARD}><summary className="cursor-pointer text-section-title font-semibold">Bank currencies & actual cash conversion</summary>
      {owner&&<ActionForm action={fxAction} submit="Bind bank currency" className="mt-4 flex flex-wrap items-end gap-3" working="Saving…" buttonClassName={QUIET}><Hidden ledgerId={ledgerId} op="bind"/><label>Unused bank account<Picker name="bankAccountId" required ariaLabel="Bank account" className="mt-1 w-full" options={bankOptions}/></label><label>Currency<select name="currency" required className={`${FIELD} ml-2`}><option>CAD</option>{enabled.map(c=><option key={c}>{c}</option>)}</select></label></ActionForm>}
      <p className="mt-2 text-sm text-ink-secondary">A bank account keeps its currency after its first entry, bank row or statement. <Link href={`/ledger/${ledgerId}/accounts`} className="underline">Create accounts</Link> before binding their currencies.</p>
      <ActionForm action={fxAction} submit="Record cash conversion" className="mt-5 space-y-3" working="Saving…" buttonClassName={QUIET}><Hidden ledgerId={ledgerId} op="transfer"/><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"><label>From account<Picker name="fromAccountId" required ariaLabel="From account" className="mt-1 w-full" options={bankOptions}/></label><label>Actual amount sent before fees<input name="fromAmount" inputMode="decimal" required className={`${FIELD} mt-1 w-full`}/></label><label>Conversion date<DateInput  name="date" required defaultValue={date} className={`${FIELD} mt-1 w-full`}/></label><label>To account<Picker name="toAccountId" required ariaLabel="To account" className="mt-1 w-full" options={bankOptions}/></label><label>Actual amount received<input name="toAmount" inputMode="decimal" required className={`${FIELD} mt-1 w-full`}/></label><label>Conversion advice / reference<input name="reference" required className={`${FIELD} mt-1 w-full`}/></label><label>Fee (source account currency)<input name="fee" inputMode="decimal" className={`${FIELD} mt-1 w-full`}/></label><label>Fee expense account<Picker name="feeAccountId" ariaLabel="Fee expense account" className="mt-1 w-full" options={feeOptions}/></label></div><details><summary className="cursor-pointer text-sm">Rate evidence for foreign-to-foreign conversion or fees</summary><RateFields prefix="destination_" currency="destination currency"/><div className="mt-3"><RateFields prefix="source_" currency="source currency"/></div></details></ActionForm>
    </details>}

    {mayInvoice&&mayBank&&<details className={CARD}><summary className="cursor-pointer text-section-title font-semibold">Closing monetary revaluation</summary><p className="my-3 text-sm text-ink-secondary">Revalue open foreign cash, receivables and payables. Original quantities stay fixed. A later settlement releases the updated carrying value.</p><ActionForm action={fxAction} submit="Post closing revaluation" className="space-y-3" working="Saving…" buttonClassName={QUIET}><Hidden ledgerId={ledgerId} op="revalue"/><label>Closing date<DateInput name="date"  required defaultValue={date} className={`${FIELD} ml-2`}/></label>{[...new Set(positions.map(p=>p.currency))].map(c=><details key={c}><summary className="cursor-pointer text-sm">{c}: use saved BOC quote or enter an evidenced closing rate</summary><RateFields prefix={`${c}_`} currency={c}/></details>)}</ActionForm></details>}

    {mayInvoice&&<section className={CARD}><h2 className="text-section-title font-semibold">Foreign documents</h2><div className="mt-3 overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th className="p-2">Document</th><th className="p-2">Status</th><th className="p-2">Original total</th><th className="p-2">Remaining</th><th className="p-2">Issue rate</th><th className="p-2">Action</th></tr></thead><tbody>{documents.map(d=><tr key={d.id} className="border-t border-line-subtle"><td className="p-2"><Link className="hover:underline" href={`/ledger/${ledgerId}/invoices/${d.id}`}>{d.number??'Draft'} · {d.party}</Link><p className="text-xs text-ink-secondary">{d.direction} {d.document_kind} · {d.issued_on}</p></td><td className="p-2">{d.status}</td><td className="p-2 font-mono">{d.currency} {formatNative(d.native_total,d.currency)}</td><td className="p-2 font-mono">{d.currency} {formatNative(d.native_balance,d.currency)}<p className="text-xs text-ink-secondary">CAD {formatMoney(d.carrying_balance)}</p></td><td className="p-2 text-xs">{d.snapshot.rate} CAD<p>{d.snapshot.source} · {d.snapshot.observedOn}</p><p className="max-w-xs break-words">{d.snapshot.reference}</p></td><td className="p-2">{d.status==='draft'&&<ActionForm action={fxAction} submit="Post saved draft" buttonClassName={QUIET} working="Saving…"><Hidden ledgerId={ledgerId} op="post"/><input type="hidden" name="invoiceId" value={d.id}/></ActionForm>}</td></tr>)}</tbody></table></div>{!documents.length&&<p className="mt-3 text-sm text-ink-secondary">No foreign documents yet.</p>}</section>}

    {mayInvoice&&<details className={CARD}><summary className="cursor-pointer text-section-title font-semibold">Correct a foreign document</summary><p className="my-3 text-sm text-ink-secondary">Reverse its settlements and related revaluations first. The original document and rate remain in history.</p><ActionForm action={fxAction} submit="Void foreign document" className="grid gap-3 sm:grid-cols-2" working="Saving…" buttonClassName={QUIET}><Hidden ledgerId={ledgerId} op="void"/><label>Document<Picker name="invoiceId" required ariaLabel="Document to void" className="mt-1 w-full" options={documents.filter(d=>d.status!=='void').map(d=>({id:d.id,label:`${d.number??'Draft'} (${d.currency})`}))}/></label><label>Correction date<DateInput name="date"  required defaultValue={date} className={`${FIELD} mt-1 w-full`}/></label><label className="sm:col-span-2">Reason<input name="reason" required className={`${FIELD} mt-1 w-full`}/></label></ActionForm></details>}
    {mayInvoice&&mayBank&&<details className={CARD}><summary className="cursor-pointer text-section-title font-semibold">Reverse a foreign settlement, transfer or revaluation</summary><p className="my-3 text-sm text-ink-secondary">Correct later activity on the same position first. Matched bank transactions must be unmatched before reversal.</p><ActionForm action={fxAction} submit="Post foreign correction" className="grid gap-3 sm:grid-cols-2" working="Saving…" buttonClassName={QUIET}><Hidden ledgerId={ledgerId} op="reverse"/><label>Entry<select name="entryId" required className={`${FIELD} mt-1 w-full`}><option value="">Choose entry</option>{entries.map(e=><option key={e.id} value={e.id}>{e.entry_no} · {e.source_type} · {e.entry_date}</option>)}</select></label><label>Correction date<DateInput  name="date" required defaultValue={date} className={`${FIELD} mt-1 w-full`}/></label><label className="sm:col-span-2">Reason<input name="reason" required className={`${FIELD} mt-1 w-full`}/></label></ActionForm></details>}
  </main>
}
