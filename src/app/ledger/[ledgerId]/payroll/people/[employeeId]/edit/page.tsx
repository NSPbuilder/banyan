
import { ToolAction } from '@/components/ToolAction'
import { TOOL_BUTTON } from '@/lib/ui'
import { requireUser } from '@/lib/gate'
import Link from 'next/link'
import { EmployeeBody } from '../../EmployeeBody'

export const dynamic = 'force-dynamic'

/** The deep link: the same body the overlay floats over the Employees list. */
export default async function EditEmployee({
  params,
}: { params: Promise<{ ledgerId: string; employeeId: string }> }) {
  await requireUser()

  const { ledgerId, employeeId } = await params
  return (
    <main className="mx-auto w-full max-w-5xl px-8 py-10 font-sans">
      <Link href={`/ledger/${ledgerId}/payroll/people`} className={TOOL_BUTTON} title="Back"><ToolAction kind="back">Back to Employees</ToolAction></Link>
      <EmployeeBody ledgerId={ledgerId} employeeId={employeeId} />
    </main>
  )
}
