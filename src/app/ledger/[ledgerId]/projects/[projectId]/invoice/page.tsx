import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/gate'

export default async function ProjectInvoiceIndex({ params }: {
  params: Promise<{ ledgerId: string; projectId: string }>
}) {
  await requireUser()
  const { ledgerId, projectId } = await params
  redirect(`/ledger/${ledgerId}/projects/${projectId}`)
}
