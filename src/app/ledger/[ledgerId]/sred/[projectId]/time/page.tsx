import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/gate'

/**
 * No screen of its own: the add form is `new` beneath this, opened from the
 * project's own page. A trimmed URL lands on the project.
 */
export default async function Page({ params }: { params: Promise<{ ledgerId: string; projectId: string }> }) {
  await requireUser()
  const { ledgerId, projectId } = await params
  redirect(`/ledger/${ledgerId}/sred/${projectId}`)
}
