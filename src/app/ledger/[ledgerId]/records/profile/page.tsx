
import { ToolAction } from '@/components/ToolAction'
import { TOOL_BUTTON } from '@/lib/ui'
import { requireUser } from '@/lib/gate'
import Link from 'next/link'
import { ProfileBody } from './ProfileBody'

export const dynamic = 'force-dynamic'

/**
 * The deep link: the same body the overlay floats over Basic Info, framed as a
 * full page. `ProfileBody` holds everything; this file may add furniture only.
 */
export default async function CompanyProfile({
  params, searchParams,
}: {
  params: Promise<{ ledgerId: string }>
  searchParams: Promise<{ reading?: string }>
}) {
  await requireUser()

  const { ledgerId } = await params
  const { reading } = await searchParams
  return (
    <main className="mx-auto w-full max-w-3xl px-8 py-10 font-sans">
      <Link href={`/ledger/${ledgerId}/records`} className={TOOL_BUTTON} title="Back"><ToolAction kind="back">Back to Corporate records</ToolAction></Link>
      <ProfileBody ledgerId={ledgerId} readingId={reading ?? null} />
    </main>
  )
}
