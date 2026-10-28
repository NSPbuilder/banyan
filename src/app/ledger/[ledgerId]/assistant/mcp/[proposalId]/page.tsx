import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireLedger } from '@/lib/gate'
import { ledgerHead } from '@/lib/ledger-head'
import { browserMcpProposal } from '@/lib/mcp-proposals'
import { McpProposalError } from '@/lib/mcp-proposal-inputs'
import { PageHeading } from '@/components/DialogHeading'
import { ProposalReview } from '../ProposalReview'
import { confirmMcpProposalAction, rejectMcpProposalAction } from '../actions'

export const dynamic = 'force-dynamic'

export default async function McpProposal({ params }: { params: Promise<{ ledgerId: string; proposalId: string }> }) {
  const { ledgerId, proposalId } = await params
  const user = await requireLedger(ledgerId, '/assistant')
  const head = await ledgerHead(ledgerId)
  const proposal = await browserMcpProposal(ledgerId, proposalId, user).catch(error => {
    if (error instanceof McpProposalError) return null
    throw error
  })
  if (!proposal) notFound()
  return <main className="mx-auto w-full max-w-4xl px-6 py-10 font-sans">
    <Link href={`/ledger/${ledgerId}/assistant/mcp`} className="text-sm text-neutral-500 underline underline-offset-4">MCP proposals</Link>
    <PageHeading className="mt-3" title="Review proposal" />
    <p className="mt-1 text-sm text-neutral-500">{head?.entity}</p>
    <ProposalReview ledgerId={ledgerId} proposal={proposal} confirm={confirmMcpProposalAction} reject={rejectMcpProposalAction} />
  </main>
}
