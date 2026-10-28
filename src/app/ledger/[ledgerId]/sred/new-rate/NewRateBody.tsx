
import { PageHeading } from '@/components/DialogHeading'
import { saveSredRateAction } from '@/app/ledger/[ledgerId]/sred/actions'
import { NewRateForm } from './NewRateForm'
import { sredRateRows } from '@/lib/sred'
import { notFound } from 'next/navigation'

/** Adding a rate, body only — floated over the SR&ED list, a full page on a deep link. */
export async function NewRateBody({ ledgerId, copyId }: { ledgerId: string; copyId?: string }) {
  const source = copyId ? (await sredRateRows()).find((r) => r.id === copyId) : null
  if (copyId && !source) notFound()
  return (
    <>
      <PageHeading className="mt-2" title={<>{source ? 'Copy rate' : 'Add a rate'}</>} />
      <NewRateForm ledgerId={ledgerId} action={saveSredRateAction} initial={source ?? undefined} />
    </>
  )
}
