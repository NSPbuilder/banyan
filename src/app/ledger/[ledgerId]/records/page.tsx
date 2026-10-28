import { PageHeader } from '@/components/PageHeader'

import { requireUser } from '@/lib/gate'
import { notFound } from 'next/navigation'
import { recordsScreenData } from './screen-data'
import { RecordsPanel } from './RecordsPanel'

export const dynamic = 'force-dynamic'

/**
 * Basic Info: the corporate facts that are not one of the three registers —
 * profile, offices, minute book. Each register page manages its OWN rows
 * (owner, 2026-09-03); the flyout and the links below reach them.
 *
 * Read-only since 2026-09-16. Editing the profile and adding an office or a
 * minute-book record each open a floating form, and a reading lands on those
 * forms (`records/profile`, `records/add/[table]`) rather than on this page.
 */
export default async function Records({
  params,
}: {
  params: Promise<{ ledgerId: string }>
}) {
  await requireUser()

  const { ledgerId } = await params
  const data = await recordsScreenData(ledgerId)
  if (!data) notFound()

  return (
    <main className="mx-auto w-full max-w-none px-8 py-10 font-sans">
      <PageHeader title={<>Corporate records — Basic Info</>} backTo={`/ledger/${ledgerId}`} backLabel={`Back to ${data.entity}`} />

      <RecordsPanel ledgerId={ledgerId} show="basic" data={data} />
    </main>
  )
}
