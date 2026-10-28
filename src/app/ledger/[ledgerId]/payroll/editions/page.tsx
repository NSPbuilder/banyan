import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/gate'

/** No screen of its own: the editions are listed on Pay runs, and one is added from there. */
export default async function Page({ params }: { params: Promise<{ ledgerId: string }> }) {
  await requireUser()
  const { ledgerId } = await params
  redirect(`/ledger/${ledgerId}/payroll`)
}
