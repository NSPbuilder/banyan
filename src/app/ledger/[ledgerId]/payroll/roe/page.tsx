import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/gate'

/**
 * No screen of its own: a typed or trimmed URL lands on the nearest one that
 * has (whole-project audit, 2026-09-13 — this segment answered 404).
 */
export default async function Page({ params }: { params: Promise<{ ledgerId: string }> }) {
  await requireUser()
  const { ledgerId } = await params
  redirect(`/ledger/${ledgerId}/payroll/people`)
}
