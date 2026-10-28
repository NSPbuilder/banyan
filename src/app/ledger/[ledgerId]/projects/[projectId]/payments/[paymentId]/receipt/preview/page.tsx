import { requireLedger } from '@/lib/gate'
import { ProjectReceiptBody } from '@/app/ledger/[ledgerId]/projects/ProjectReceiptBody'

export const dynamic = 'force-dynamic'

export default async function ProjectReceiptPage({ params }: {
  params: Promise<{ ledgerId: string; projectId: string; paymentId: string }>
}) {
  const scope = await params
  await requireLedger(scope.ledgerId, '/projects')
  return <ProjectReceiptBody {...scope} crumb />
}
