import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/gate'

export default async function TemplateIndex({ params }: {
  params: Promise<{ ledgerId: string }>
}) {
  await requireUser()
  const { ledgerId } = await params
  redirect(`/ledger/${ledgerId}/invoices/templates`)
}
