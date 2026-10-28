/** URL-backed invoice filters. Dates refer to issued_on, inclusive at both ends. */
export type InvoiceFilters = {
  q: string
  from: string
  to: string
  direction: '' | 'sales' | 'purchase'
  partyId: string
}

export type InvoiceFilterParams = Record<string, string | string[] | undefined>

export function isInvoiceFilterDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

export function invoiceFilterError(filters: Partial<InvoiceFilters>): string | null {
  if (filters.from && !isInvoiceFilterDate(filters.from)
      || filters.to && !isInvoiceFilterDate(filters.to)) return 'Enter valid issued dates.'
  if (filters.from && filters.to && filters.from > filters.to) return 'Issued from must be on or before Issued to.'
  if (filters.direction && filters.direction !== 'sales' && filters.direction !== 'purchase') return 'Choose Sales, Purchase or All types.'
  if (filters.partyId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(filters.partyId)) return 'Choose a party from the list.'
  return null
}

export function readInvoiceFilters(params: InvoiceFilterParams): { filters: InvoiceFilters; error: string | null } {
  const one = (name: string) => {
    const value = params[name]
    return (Array.isArray(value) ? value[0] : value)?.trim() ?? ''
  }
  const direction = one('direction')
  const filters: InvoiceFilters = {
    q: one('q'), from: one('from'), to: one('to'),
    direction: direction as InvoiceFilters['direction'], partyId: one('party'),
  }
  return { filters, error: invoiceFilterError(filters) }
}
