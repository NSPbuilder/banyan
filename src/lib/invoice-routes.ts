/** Sales invoices and supplier bills share accounting, but have separate workspaces. */
export type InvoiceDirection = 'sales' | 'purchase'

export function invoicePath(direction: InvoiceDirection, id?: string): string {
  const base = direction === 'purchase' ? '/bills' : '/invoices'
  return id ? `${base}/${id}` : base
}

export function invoiceHref(ledgerId: string, direction: InvoiceDirection, id?: string): string {
  return `/ledger/${ledgerId}${invoicePath(direction, id)}`
}
