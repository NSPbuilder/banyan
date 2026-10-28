import Link from 'next/link'
import { ActionForm, type FormAction } from '@/components/ActionForm'
import { formatNative } from '@/lib/fx-money'
import type { McpProposalView } from '@/lib/mcp-proposals'
import { BUTTON } from '@/lib/ui'

const when = (value: string) => value.replace('T', ' ').slice(0, 19)
const amount = (value: string, currency: string) => formatNative(BigInt(value), currency)
export const proposalTitle = (p: McpProposalView) => p.preview.operation === 'propose_invoice_draft'
  ? `${p.preview.direction === 'sales' ? 'Sales' : 'Purchase'} ${p.preview.kind === 'credit_note' ? 'credit note' : p.preview.direction === 'sales' ? 'invoice' : 'bill'}`
  : p.preview.operation === 'propose_expense_draft' ? 'Expense journal' : 'Manual journal'

export function ProposalReview({ proposal: p, ledgerId, confirm, reject }: {
  proposal: McpProposalView; ledgerId: string; confirm: FormAction; reject: FormAction
}) {
  const v = p.preview
  const hidden = <><input type="hidden" name="ledgerId" value={ledgerId} />
    <input type="hidden" name="proposalId" value={p.proposalId} />
    <input type="hidden" name="expectedDigest" value={p.digest} /></>
  return <div className="mt-6 min-w-0 space-y-5 text-sm" data-mcp-proposal-review>
    <section className="rounded border border-neutral-200 p-4 dark:border-neutral-800">
      <p className="font-semibold capitalize" role="status">{p.status}</p>
      <dl className="mt-3 grid grid-cols-[7rem_minmax(0,1fr)] gap-x-4 gap-y-2">
        <dt className="text-neutral-500">Requested by</dt><dd className="break-words">{p.requestedBy}</dd>
        <dt className="text-neutral-500">Connection</dt><dd className="break-words">{p.credentialName}</dd>
        <dt className="text-neutral-500">Created</dt><dd>{when(p.createdAt)}</dd>
        <dt className="text-neutral-500">Expires</dt><dd>{when(p.expiresAt)}</dd>
        <dt className="text-neutral-500">Request</dt><dd className="whitespace-pre-wrap break-words">{p.reason}</dd>
      </dl>
    </section>
    <section className="rounded border border-neutral-200 p-4 dark:border-neutral-800">
      <h2 className="font-semibold">{proposalTitle(p)} · {v.currency}</h2>
      <dl className="mt-3 grid grid-cols-[7rem_minmax(0,1fr)] gap-x-4 gap-y-2">
        <dt className="text-neutral-500">Date</dt><dd>{v.date}</dd>
        {v.control && <><dt className="text-neutral-500">{v.direction === 'sales' ? 'Receivable' : 'Payable'}</dt>
          <dd className="break-words">{v.control.code} · {v.control.account}<span className="mt-1 block text-xs text-neutral-500">{v.control.accountId}</span></dd></>}
        {v.dueOn && <><dt className="text-neutral-500">Due</dt><dd>{v.dueOn}</dd></>}
        {v.party && <><dt className="text-neutral-500">Party</dt><dd className="break-words">{v.party}</dd></>}
        <dt className="text-neutral-500">Description</dt><dd className="whitespace-pre-wrap break-words">{v.description}</dd>
        {v.reference && <><dt className="text-neutral-500">Reference</dt><dd className="break-words">{v.reference}</dd></>}
        {v.note && <><dt className="text-neutral-500">Note</dt><dd className="whitespace-pre-wrap break-words">{v.note}</dd></>}
      </dl>
      <div className="mt-5 max-w-full overflow-x-auto">
        <table className="w-full min-w-[38rem] text-left">
          <thead><tr className="border-b border-neutral-300"><th className="py-2 pr-3">Account</th><th className="py-2 pr-3">Description / tax</th>
            <th className="py-2 pr-3 text-right">Signed {v.currency}</th>{v.currency !== 'CAD' && <th className="py-2 text-right">Signed CAD</th>}</tr></thead>
          <tbody>{v.lines.map((line, i) => <tr key={i} className="border-b border-neutral-200 align-top">
            <td className="max-w-60 break-words py-2 pr-3">{line.code} · {line.account}</td>
            <td className="max-w-80 whitespace-pre-wrap break-words py-2 pr-3">{line.description}
              {line.party && <span className="mt-1 block text-xs text-neutral-500">Party: {line.party} · {line.partyId}</span>}
              {line.taxCode && <span className="mt-1 block text-xs text-neutral-500">{line.generatedFor ? `${line.generatedFor} tax line` : line.taxCode}</span>}</td>
            <td className="whitespace-nowrap py-2 pr-3 text-right tabular-nums">{amount(line.nativeMinor, v.currency)}</td>
            {v.currency !== 'CAD' && <td className="whitespace-nowrap py-2 text-right tabular-nums">{amount(line.functionalMinor, 'CAD')}</td>}
          </tr>)}{v.control && <tr className="border-b border-neutral-200 align-top">
            <td className="max-w-60 break-words py-2 pr-3">{v.control.code} · {v.control.account}</td>
            <td className="py-2 pr-3">{v.direction === 'sales' ? 'Receivable' : 'Payable'} control movement</td>
            <td className="whitespace-nowrap py-2 pr-3 text-right tabular-nums">{amount(v.control.nativeMinor, v.currency)}</td>
            {v.currency !== 'CAD' && <td className="whitespace-nowrap py-2 text-right tabular-nums">{amount(v.control.functionalMinor, 'CAD')}</td>}
          </tr>}</tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-neutral-500">Signed account movements: debits positive, credits negative. These are proposed draft lines.</p>
      <p className="mt-4 font-semibold tabular-nums">{v.operation === 'propose_entry_draft' ? 'Total debits' : 'Document total'}: {amount(v.totalMinor, v.currency)}
        {v.currency !== 'CAD' && <> · CAD carrying value {amount(v.functionalMinor, 'CAD')}</>}</p>
      {v.quote && <div className="mt-4 break-words rounded bg-neutral-100 p-3 text-xs dark:bg-neutral-900">
        <p>1 {v.currency} = {v.quote.rate} CAD · {v.quote.observedOn} · {v.quote.source}</p>
        <p className="mt-1 whitespace-pre-wrap">{v.quote.reference}</p>
      </div>}
    </section>
    {p.blockedReason && <p className="rounded border border-neutral-300 p-3" role="status">{p.blockedReason}</p>}
    {p.status === 'pending' && <p className="text-neutral-500">Confirm creates one draft with these exact values. Review and post the draft in its ordinary workspace.</p>}
    {(p.canConfirm || p.canReject) && <div className="flex flex-wrap items-start gap-3">
      {p.canConfirm && <ActionForm action={confirm} submit="Create draft" working="Creating draft…" className="min-w-0" buttonClassName={BUTTON}>{hidden}</ActionForm>}
      {p.canReject && <ActionForm action={reject} submit="Reject proposal" working="Rejecting…" className="min-w-0" buttonClassName="rounded border border-neutral-300 px-4 py-2 text-sm">{hidden}</ActionForm>}
    </div>}
    {p.result && <p className="rounded border border-neutral-300 p-4"><Link className="underline underline-offset-4" href={p.result.href}>Open created {p.result.type === 'invoice' ? 'document' : 'journal draft'}</Link>
      <span className="ml-2 text-neutral-500">Current status: {p.result.currentStatus}</span></p>}
    {p.status === 'created' && !p.result && <p className="text-neutral-500">This proposal was consumed. The original draft is no longer available here; confirming again will not create a replacement.</p>}
  </div>
}
