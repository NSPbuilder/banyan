import Link from 'next/link'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { requireLedger } from '@/lib/gate'
import { invoiceDetail } from '@/lib/invoices'
import { fxDocumentPosition } from '@/lib/fx'
import { formatNative, type FxSnapshot } from '@/lib/fx-money'
import { formatMoney } from '@/lib/money'
import { QUIET } from '@/lib/ui'
import { Attachments } from '../entries/[entryId]/Attachments'

function RateEvidence({ quote }: { quote: FxSnapshot }) {
  return <p className="break-words text-sm text-neutral-600 dark:text-neutral-400">
    {quote.source} · {quote.observedOn} · 1 {quote.currency} = {quote.rate} CAD · {quote.reference}
  </p>
}

export async function FxInvoiceDetail({ detail }: { detail: NonNullable<Awaited<ReturnType<typeof invoiceDetail>>> }) {
  const { invoice, lines } = detail
  await requireLedger(invoice.ledger_id, '/invoices')
  const currency = invoice.fx_currency!
  const position = await fxDocumentPosition(db, invoice.id)
  const original = -lines.reduce((s, l) => s + l.original_amount!, 0n)
  return <section className="space-y-4" aria-label="Foreign document">
    <h1 className="text-2xl font-semibold">{invoice.number ?? invoice.their_ref ?? 'Foreign document'}</h1>
    <p>{invoice.party_name} · {invoice.status} · issued {invoice.issued_on} · due {invoice.due_on}</p>
    <RateEvidence quote={invoice.fx_snapshot!} />
    <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th>Account</th><th>Description</th><th className="text-right">{currency}</th><th className="text-right">CAD at issue</th></tr></thead><tbody>
      {lines.map(l => <tr key={l.line_no} className="border-t border-neutral-200"><td className="py-2">{l.code} {l.name}</td><td>{l.description}</td><td className="text-right tabular-nums">{formatNative(l.original_amount!, currency)}</td><td className="text-right tabular-nums">{formatMoney(l.amount)}</td></tr>)}
    </tbody></table></div>
    <p>Original document: {currency} {formatNative(original,currency)} · CAD at issue {formatMoney(position.historical_total)}</p>
    <p>Open balance: {currency} {formatNative(position.native_balance,currency)} · CAD carrying value {formatMoney(position.carrying_balance)}</p>
    <div className="flex flex-wrap gap-2"><Link className={QUIET} href={`/ledger/${invoice.ledger_id}/fx`}>Settle or correct in Currencies &amp; FX</Link>
      {invoice.direction==='sales' && invoice.status==='posted' && <a className={QUIET} href={`/ledger/${invoice.ledger_id}/invoices/${invoice.id}/pdf`}>Invoice PDF</a>}
      {invoice.entry_id && <Link className={QUIET} href={`/ledger/${invoice.ledger_id}/entries/${invoice.entry_id}`}>Journal and original rate evidence</Link>}
    </div>
    {invoice.entry_id && <Attachments ledgerId={invoice.ledger_id} entryId={invoice.entry_id} />}
  </section>
}

export async function FxEntryDetail({ ledgerId, entryId, number, date, description, status }: { ledgerId:string;entryId:string;number:string|null;date:string;description:string;status:string }) {
  await requireLedger(ledgerId,'/entries')
  const rows=await db.execute<{line_no:number;code:string;name:string;amount:bigint;original_amount:bigint|null;original_currency:string|null;fx_snapshot:FxSnapshot|null}>(sql`
    SELECT j.line_no,a.code,a.name,j.amount,j.original_amount,j.original_currency,j.fx_snapshot FROM journal_line j
    JOIN account a ON a.id=j.account_id WHERE j.entry_id=${entryId}::uuid ORDER BY j.line_no`)
  return <section className="space-y-4" aria-label="Foreign journal evidence">
    <h1 className="text-2xl font-semibold">{number ?? 'Foreign entry'}</h1><p>{date} · {status} · {description}</p>
    <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th>Account</th><th className="text-right">Original amount</th><th className="text-right">CAD debit / credit</th></tr></thead><tbody>{rows.map(r=><tr key={r.line_no} className="border-t border-neutral-200"><td className="py-2">{r.code} {r.name}</td><td className="text-right">{r.original_currency && `${r.original_currency} ${formatNative(r.original_amount!,r.original_currency)}`}</td><td className="text-right">{formatMoney(r.amount)}</td></tr>)}</tbody></table></div>
    {rows.filter(r=>r.fx_snapshot).map(r=><div key={r.line_no}><p className="text-sm font-medium">Line {r.line_no} · {r.code}</p><RateEvidence quote={r.fx_snapshot!} />{r.fx_snapshot!.settlement&&<p className="break-words text-sm">Actual cash before fees: {r.fx_snapshot!.settlement!.bankCurrency} {formatNative(BigInt(r.fx_snapshot!.settlement!.grossMinor),r.fx_snapshot!.settlement!.bankCurrency)} · fee {formatNative(BigInt(r.fx_snapshot!.settlement!.feeMinor),r.fx_snapshot!.settlement!.bankCurrency)} · {r.fx_snapshot!.settlement!.reference}</p>}</div>)}
    <Link className={QUIET} href={`/ledger/${ledgerId}/fx`}>Corrections in Currencies &amp; FX</Link>
    <Attachments ledgerId={ledgerId} entryId={entryId}/>
  </section>
}

export function FxCopyRefusal({ ledgerId }: { ledgerId:string }) {
  return <section className="space-y-3"><h1 className="text-xl font-semibold">Create a reviewed foreign document</h1><p>Foreign sources keep their original currency and rate. Enter the new document and its own rate in Currencies &amp; FX.</p><Link className={QUIET} href={`/ledger/${ledgerId}/fx`}>Currencies &amp; FX</Link></section>
}
