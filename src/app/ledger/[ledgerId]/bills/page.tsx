import { requireUser } from '@/lib/gate'
import { InvoiceListPage, type InvoiceListProps } from '../invoices/InvoiceListPage'

export const dynamic = 'force-dynamic'

export default async function Bills(props: InvoiceListProps) {
  await requireUser()
  return <InvoiceListPage {...props} direction="purchase" />
}
