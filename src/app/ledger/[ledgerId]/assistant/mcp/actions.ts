'use server'

import { revalidatePath } from 'next/cache'
import { requireLedger } from '@/lib/gate'
import { decideMcpProposal } from '@/lib/mcp-proposals'
import { McpProposalError } from '@/lib/mcp-proposal-inputs'
import type { FormState } from '@/app/actions'

async function decide(form: FormData, decision: 'confirm' | 'reject'): Promise<FormState> {
  const ledgerId = String(form.get('ledgerId') ?? '')
  const user = await requireLedger(ledgerId, '/assistant')
  try {
    const proposalId = String(form.get('proposalId') ?? '')
    const result = await decideMcpProposal({ ledgerId, proposalId,
      expectedDigest: String(form.get('expectedDigest') ?? ''), decision, user })
    revalidatePath(`/ledger/${ledgerId}/assistant/mcp`)
    revalidatePath(`/ledger/${ledgerId}/assistant/mcp/${proposalId}`)
    revalidatePath(`/ledger/${ledgerId}/invoices`)
    revalidatePath(`/ledger/${ledgerId}/entries`)
    return { ok: result.status === 'created' ? 'Draft created. Review it in the ordinary document workspace before posting.' : 'Proposal rejected. No draft was created.' }
  } catch (error) {
    return { error: error instanceof McpProposalError ? error.message : 'The proposal could not be completed. No new draft was saved; ask the operator to review the error.' }
  }
}

export async function confirmMcpProposalAction(_previous: FormState, form: FormData) {
  return decide(form, 'confirm')
}
export async function rejectMcpProposalAction(_previous: FormState, form: FormData) {
  return decide(form, 'reject')
}
