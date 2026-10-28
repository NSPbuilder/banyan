import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/gate'

/**
 * The intercept tree's twin of entries/quick/page.tsx: without it the dynamic
 * (.)entries/[entryId] intercept would swallow a client-side navigation to
 * /entries/quick (N4). Same answer as the real page — the nearest screen.
 */
export default async function Page({ params }: { params: Promise<{ ledgerId: string }> }) {
  await requireUser()
  const { ledgerId } = await params
  redirect(`/ledger/${ledgerId}/entries/quick/expense`)
}
