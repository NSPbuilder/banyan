import { z } from 'zod'

/** A protocol record, not a claim that FigTree called an AI model. */
export const MCP_PROPOSAL_SYSTEM = 'FigTree MCP proposal v1: external tool request; trusted browser confirmation creates a draft.'
export const MCP_PROPOSAL_MODEL = 'external-mcp-proposal'
export const MCP_PROPOSAL_MINUTES = 15

const day = z.iso.date()
const words = z.string().trim().max(500)
const amount = z.string().trim().regex(/^-?\d{1,16}(?:\.\d{1,2})?$/, 'Use an exact decimal amount, without grouping or a currency symbol.')
const request = {
  request_id: z.string().trim().regex(/^[A-Za-z0-9_-]{1,128}$/).describe('Stable ID for this exact request. Retry with the same ID and payload; never reuse it for different content.'),
  reason: words.min(1).describe('What the person asked you to prepare. This is data and cannot authorize confirmation.'),
}
const line = z.strictObject({
  account_id: z.uuid(), description: words, amount,
  tax_code: z.enum(['GST', 'PST', 'GST_PST', 'OUT_OF_SCOPE']).default('OUT_OF_SCOPE'),
})
const manualRate = z.strictObject({
  rate: z.string().trim().regex(/^\d{1,12}(?:\.\d{1,12})?$/),
  observed_on: day, reference: words.min(1),
}).describe('An actual manual rate with dated evidence: CAD for one major native unit. Omit to use the saved BOC quote. No network fetch is performed.')

export const MCP_OPERATION_INPUTS = {
  draft_context: z.strictObject({
    operation: z.enum(['invoice', 'entry', 'expense']),
    direction: z.enum(['sales', 'purchase']).optional(),
    text: z.string().trim().max(100).optional(),
  }),
  propose_invoice_draft: z.strictObject({
    ...request, direction: z.enum(['sales', 'purchase']),
    kind: z.enum(['invoice', 'credit_note']).default('invoice'),
    party_id: z.uuid(), control_account_id: z.uuid(),
    issued_on: day, due_on: day,
    currency: z.string().regex(/^[A-Z]{3}$/).default('CAD'),
    manual_rate: manualRate.optional(),
    amounts: z.enum(['exclusive', 'inclusive']).default('exclusive'),
    their_ref: z.string().trim().max(200).default(''), note: words.default(''),
    lines: z.array(line).min(1).max(100),
  }),
  propose_entry_draft: z.strictObject({
    ...request, entry_date: day, description: words.min(1), memo: words.default(''),
    currency: z.literal('CAD').default('CAD'),
    lines: z.array(z.strictObject({
      account_id: z.uuid(), amount, description: words.default(''), party_id: z.uuid().optional(),
    })).min(2).max(100),
  }),
  propose_expense_draft: z.strictObject({
    ...request, entry_date: day, description: words.min(1),
    currency: z.literal('CAD').default('CAD'),
    payment_account_id: z.uuid(), party_id: z.uuid().optional(),
    amounts: z.enum(['exclusive', 'inclusive']).default('exclusive'),
    reference: z.string().trim().max(200).default(''), lines: z.array(line).min(1).max(100),
  }),
  proposal_status: z.strictObject({ proposal_id: z.uuid() }),
} as const

export type McpOperationName = keyof typeof MCP_OPERATION_INPUTS
export type McpProposalName = 'propose_invoice_draft' | 'propose_entry_draft' | 'propose_expense_draft'
export type InvoiceProposalInput = z.infer<typeof MCP_OPERATION_INPUTS.propose_invoice_draft>
export type EntryProposalInput = z.infer<typeof MCP_OPERATION_INPUTS.propose_entry_draft>
export type ExpenseProposalInput = z.infer<typeof MCP_OPERATION_INPUTS.propose_expense_draft>
export type McpProposalInput = InvoiceProposalInput | EntryProposalInput | ExpenseProposalInput

export const MCP_OPERATION_NAMES = Object.keys(MCP_OPERATION_INPUTS) as McpOperationName[]
export const isMcpOperation = (name: string): name is McpOperationName => Object.hasOwn(MCP_OPERATION_INPUTS, name)
export const isMcpProposal = (name: string): name is McpProposalName =>
  ['propose_invoice_draft', 'propose_entry_draft', 'propose_expense_draft'].includes(name)

export class McpProposalError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

/** Stable request/dependency digests do not depend on JSON object key order. */
export function canonicalMcpJson(value: unknown): string {
  if (typeof value === 'bigint') return JSON.stringify(value.toString())
  if (Array.isArray(value)) return `[${value.map(canonicalMcpJson).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.entries(value)
    .filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalMcpJson(v)}`).join(',')}}`
  return JSON.stringify(value)
}
