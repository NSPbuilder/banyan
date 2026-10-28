import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/gate'

/**
 * No screen of its own: every add form is `add/[table]`, reached from its
 * register's Add button. A trimmed URL lands on Basic Info, where they start.
 */
export default async function Page({ params }: { params: Promise<{ ledgerId: string }> }) {
  await requireUser()
  const { ledgerId } = await params
  redirect(`/ledger/${ledgerId}/records`)
}
