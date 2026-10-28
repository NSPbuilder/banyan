import { requireUser } from '@/lib/gate'
import { invoiceHref } from '@/lib/invoice-routes'
import { redirect } from 'next/navigation'
import { InvoiceListPage, type InvoiceListProps } from './InvoiceListPage'

export const dynamic = 'force-dynamic'

export default async function Invoices(props: InvoiceListProps) {
  await requireUser()
  const query = await props.searchParams
  if (query.direction === 'purchase') {
    const { ledgerId } = await props.params
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
      if (key !== 'direction' && value) search.set(key, Array.isArray(value) ? value[0] : value)
    }
    redirect(invoiceHref(ledgerId, 'purchase') + (search.size ? '?' + search.toString() : ''))
  }
  return <InvoiceListPage {...props} direction="sales" />
}
