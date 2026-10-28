import { requireUser } from '@/lib/gate'
import { OverlayPanel } from '@/components/OverlayPanel'
import { ProfileBody } from '../../../records/profile/ProfileBody'

export const dynamic = 'force-dynamic'

/** The overlay exit: same body as the full page, floated over Basic Info. */
export default async function CompanyProfileOverlay({
  params, searchParams,
}: {
  params: Promise<{ ledgerId: string }>
  searchParams: Promise<{ reading?: string }>
}) {
  await requireUser()

  const { ledgerId } = await params
  const { reading } = await searchParams
  return (
    <OverlayPanel>
      <ProfileBody ledgerId={ledgerId} readingId={reading ?? null} />
    </OverlayPanel>
  )
}
