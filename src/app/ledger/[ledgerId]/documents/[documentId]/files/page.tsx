import { redirect } from 'next/navigation'
import { requireLedger } from '@/lib/gate'

export default async function DocumentFiles({ params }: { params: Promise<{ ledgerId: string; documentId: string }> }) {
  const { ledgerId, documentId } = await params
  await requireLedger(ledgerId, '/documents')
  redirect(`/ledger/${ledgerId}/documents/${documentId}`)
}
