import { requireUser } from '@/lib/gate'
import { OverlayPanel } from '@/components/OverlayPanel'
import { EmployeeBody } from '../../../../../payroll/people/EmployeeBody'

export const dynamic = 'force-dynamic'

/** The overlay exit: same body as the full page, floated over the Employees list. */
export default async function EditEmployeeOverlay({
  params,
}: { params: Promise<{ ledgerId: string; employeeId: string }> }) {
  await requireUser()

  const { ledgerId, employeeId } = await params
  return (
    <OverlayPanel>
      <EmployeeBody ledgerId={ledgerId} employeeId={employeeId} />
    </OverlayPanel>
  )
}
