
import { ToolAction } from '@/components/ToolAction'
import { TOOL_BUTTON } from '@/lib/ui'
import { requireUser } from '@/lib/gate'
import Link from 'next/link'
import { EmployeeBody } from '../EmployeeBody'

export const dynamic = 'force-dynamic'

/**
 * The deep link: the same body the overlay floats over the Employees list.
 * A LITERAL page, not a gap for `[employeeId]` to fill with "new" (N7).
 */
export default async function NewEmployee({
  params, searchParams,
}: { params: Promise<{ ledgerId: string }>; searchParams: Promise<{ copy?: string }> }) {
  await requireUser()

  const { ledgerId } = await params
  const { copy } = await searchParams
  return (
    <main className="mx-auto w-full max-w-5xl px-8 py-10 font-sans">
      <Link href={`/ledger/${ledgerId}/payroll/people`} className={TOOL_BUTTON} title="Back"><ToolAction kind="back">Back to Employees</ToolAction></Link>
      <EmployeeBody ledgerId={ledgerId} employeeId={null} copyId={copy} />
    </main>
  )
}
