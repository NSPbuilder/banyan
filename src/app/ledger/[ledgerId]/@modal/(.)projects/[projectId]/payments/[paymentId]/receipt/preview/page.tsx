import { requireLedger } from '@/lib/gate'
import { OverlayPanel } from '@/components/OverlayPanel'
import { ProjectReceiptBody } from '@/app/ledger/[ledgerId]/projects/ProjectReceiptBody'

export const dynamic = 'force-dynamic'

export default async function ProjectReceiptOverlay({ params }: {
  params: Promise<{ ledgerId: string; projectId: string; paymentId: string }>
}) {
  const scope = await params
  await requireLedger(scope.ledgerId, '/projects')
  return <OverlayPanel size="wide" returnTo={`/ledger/${scope.ledgerId}/projects/${scope.projectId}`}>
    <ProjectReceiptBody {...scope} />
  </OverlayPanel>
}
