import 'server-only'
import { asEnteredAmount, type invoiceDetail, type DocumentKind } from './invoices'
import { moneyInput } from './money'
import type { RowState } from './invoice-rows'

/** Missing historical source data is not reconstructed from rounded tax lines.
 * Such documents open with every stored amount as a plain editable line. */
export function invoiceEditorState(detail: NonNullable<Awaited<ReturnType<typeof invoiceDetail>>>): RowState {
  const { invoice, lines } = detail
  const source = lines.filter(l => !l.generated_for)
  const hasSource = source.length > 0 && source.every(l => l.input_amount != null
    && l.input_inclusive != null && l.input_inclusive === source[0].input_inclusive)
  const editable = hasSource ? source : lines
  return {
    nextKey: editable.length,
    inclusive: hasSource ? source[0].input_inclusive! : false,
    rows: editable.map((l, i) => ({
      key: i, account: l.account_id, description: l.description ?? '',
      amount: moneyInput(hasSource ? BigInt(l.input_amount!)
        : asEnteredAmount(invoice.direction, invoice.document_kind as DocumentKind, BigInt(l.amount))),
      taxCode: hasSource ? l.tax_code ?? 'OUT_OF_SCOPE' : 'OUT_OF_SCOPE',
      gst: hasSource && l.gst_override != null ? moneyInput(BigInt(l.gst_override)) : undefined,
      pst: hasSource && l.pst_override != null ? moneyInput(BigInt(l.pst_override)) : undefined,
    })),
  }
}
