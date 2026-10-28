import { requireUser } from '@/lib/gate'
import { OverlayPanel } from '@/components/OverlayPanel'
import { CompanyTemplatesBody } from '../../../invoices/templates/CompanyTemplatesBody'

export const dynamic = 'force-dynamic'

/** Keep the static templates door from being read as an invoice id. */
export default async function TemplatesOverlay({ params }: { params: Promise<{ ledgerId: string }> }) {
  await requireUser()
  const { ledgerId } = await params
  return <OverlayPanel size="wide" returnTo={`/ledger/${ledgerId}/invoices`}>
    <CompanyTemplatesBody ledgerId={ledgerId} />
  </OverlayPanel>
}
