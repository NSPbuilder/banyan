import Link from 'next/link'
import { requireLedger } from '@/lib/gate'
import { ledgerHead } from '@/lib/ledger-head'
import { browserMcpProposals } from '@/lib/mcp-proposals'
import { PageHeading } from '@/components/DialogHeading'
import { proposalTitle } from './ProposalReview'

export const dynamic = 'force-dynamic'

export default async function McpProposals({ params }: { params: Promise<{ ledgerId: string }> }) {
  const { ledgerId } = await params
  const user = await requireLedger(ledgerId, '/assistant')
  const [head, proposals] = await Promise.all([ledgerHead(ledgerId), browserMcpProposals(ledgerId, user)])
  return <main className="mx-auto w-full max-w-4xl px-6 py-10 font-sans">
    <Link href={`/ledger/${ledgerId}/assistant`} className="text-sm text-neutral-500 underline underline-offset-4">AI</Link>
    <PageHeading className="mt-3" title="MCP proposals" />
    <p className="mt-1 text-sm text-neutral-500">{head?.entity}</p>
    <p className="mt-5 max-w-2xl text-sm text-neutral-500">Your external AI can prepare proposals through its explicitly authorized MCP connection. Review the exact values here; confirmation creates a draft for the normal posting workflow. Your internal AI service is not required.</p>
    <h2 className="mt-8 text-xs font-semibold uppercase tracking-widest text-neutral-500">Your most recent proposals · up to 30</h2>
    {!proposals.length ? <p className="mt-4 text-sm text-neutral-500">No proposals available. New draft capabilities need operator enablement and an explicitly scoped MCP credential.</p>
      : <ol className="mt-4 space-y-3">{proposals.map(p => <li key={p.proposalId} className="rounded border border-neutral-200 p-4 text-sm dark:border-neutral-800">
        <Link href={p.reviewUrl} className="font-semibold underline underline-offset-4">{proposalTitle(p)}</Link>
        <span className="ml-3 capitalize text-neutral-500">{p.status}</span>
        <p className="mt-2 whitespace-pre-wrap break-words">{p.reason}</p>
        <p className="mt-2 text-xs text-neutral-500">{p.credentialName} · {p.createdAt.slice(0, 19)}</p>
      </li>)}</ol>}
  </main>
}
