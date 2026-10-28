import { requireUser } from '@/lib/gate'
import { OverlayPanel } from '@/components/OverlayPanel'
import { EmployeeBody } from '../../../../payroll/people/EmployeeBody'

export const dynamic = 'force-dynamic'

/** The overlay exit: same body as the full page, floated over the Employees list. */
export default async function NewEmployeeOverlay({
  params, searchParams,
}: { params: Promise<{ ledgerId: string }>; searchParams: Promise<{ copy?: string }> }) {
  await requireUser()

  const { ledgerId } = await params
  const { copy } = await searchParams
  return (
    <OverlayPanel>
      <EmployeeBody ledgerId={ledgerId} employeeId={null} copyId={copy} />
    </OverlayPanel>
  )
}
