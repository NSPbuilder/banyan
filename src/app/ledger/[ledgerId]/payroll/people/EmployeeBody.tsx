
import { PageHeading } from '@/components/DialogHeading'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { eligibleParties, listEmployees } from '@/lib/payroll/employees'
import { ledgerHead } from '@/lib/ledger-head'
import { EmployeeForm } from './EmployeeForm'
import { ActionForm } from '@/components/ActionForm'
import { deleteEmployeeAction } from '@/app/ledger/[ledgerId]/payroll/actions'
import { PAYROLL_FIELDS } from '@/lib/forms'
import { QUIET } from '@/lib/ui'

/**
 * Adding somebody to the payroll, or editing them — body only. The Employees
 * list's Add employee button and each row's edit float it (owner, 2026-09-16:
 * 「在 payroll 下的 employee 也加一个直接添加 employee 的按钮」); a deep link
 * renders it as a page.
 *
 * ONE FORM, two jobs: adding somebody and editing somebody are the same
 * fields with the same rules, so they are the same component with the record
 * handed in or not. Two forms would be two answers to "what may be set about
 * an employee", and the second one would fall behind.
 *
 * The add form ALWAYS opens. It used to render only when somebody already held
 * the employee role and was off the payroll, and send everybody else to the
 * parties page — so the first employee a company ever had could not be added
 * from here, although the form's own picker creates the person.
 */
export async function EmployeeBody({ ledgerId, employeeId, copyId }: {
  ledgerId: string; employeeId: string | null; copyId?: string
}) {
  const head = await ledgerHead(ledgerId)
  if (!head) notFound()

  if (employeeId) {
    const editing = (await listEmployees(ledgerId)).find((e) => e.id === employeeId)
    if (!editing) notFound()
    return (
      <>
        <PageHeading className="mt-2" title={<>Edit {editing.party_name}</>} />
        <p className="mt-1 text-sm text-neutral-500">{head.entity}</p>

        <EmployeeForm ledgerId={ledgerId} parties={[]} editing={editing} />
        <p className="mt-3 text-xs text-neutral-500">
          <Link href={`/ledger/${ledgerId}/payroll/people/${editing.id}`} className="underline">
            {editing.party_name}&apos;s pay this year
          </Link>
        </p>
        {/* For a record entered by mistake (owner, 2026-09-16: 「所有的紀錄儘量都可以
            編輯刪除」). Somebody already paid is refused and told to untick
            Active — the stubs are the year's record. */}
        <ActionForm action={deleteEmployeeAction} submit="Delete this payroll record" working="Deleting…"
                    className="mt-6 flex flex-wrap items-center gap-3" buttonClassName={`${QUIET} text-red-700 dark:text-red-400`}>
          <input type="hidden" name={PAYROLL_FIELDS.ledgerId} value={ledgerId} />
          <input type="hidden" name={PAYROLL_FIELDS.employeeId} value={editing.id} />
          <span className="text-xs text-neutral-500">Only for somebody never paid; anyone else, untick Active.</span>
        </ActionForm>
      </>
    )
  }

  const available = await eligibleParties(ledgerId)
  const source = copyId ? (await listEmployees(ledgerId)).find((e) => e.id === copyId) : null
  if (copyId && !source) notFound()
  return (
    <>
      <PageHeading className="mt-2" title={<>{source ? 'Copy employee setup' : 'Add an employee'}</>} />
      <p className="mt-1 text-sm text-neutral-500">{head.entity}</p>

      {available.length === 0 && (
        <p className="mt-2 max-w-2xl text-xs text-neutral-500">
          Nobody holding the employee role is off the payroll — type the name to add somebody new.
        </p>
      )}
      <EmployeeForm ledgerId={ledgerId} parties={available} editing={null} initial={source ?? undefined} />
    </>
  )
}
