
import { ToolAction } from '@/components/ToolAction'
import { TOOL_BUTTON } from '@/lib/ui'
import { requireUser } from '@/lib/gate'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { localToday } from '@/lib/today'
import { actorOf } from '@/lib/gate'
import {
  REGISTER_KINDS,
  logRegisterExport, renderRegisterForLedger, type Audience, type RegisterKind,
} from '@/lib/registers'
import { RegisterView } from './RegisterView'
import { recordsScreenData } from '../../screen-data'
import type { RecordsShow } from '../../RecordsScreen'
import { RecordsPanel } from '../../RecordsPanel'
import { DateInput } from '@/components/DateInput'
import { FIELD } from '@/lib/ui'

const MANAGE: Record<RegisterKind, RecordsShow> = {
  directors: 'directors',
  central_securities: 'securities',
  transparency: 'transparency',
}

export const dynamic = 'force-dynamic'

/**
 * One register, rendered once, previewed and printed from the same structure.
 *
 * Every render logs an export trail — this page IS the export surface, and
 * the design doc requires knowing who asked for which register as at when.
 * The REGISTER itself comes only from `renderRegister`; the management
 * section below it eats `recordsScreenData`, the same assembly the Basic
 * Info page eats — and it renders for the DIRECTOR audience only, because a
 * public preview exists precisely to show what an outsider would see.
 */
export default async function Register({
  params, searchParams,
}: {
  params: Promise<{ ledgerId: string; kind: string }>
  searchParams: Promise<{ asOf?: string; audience?: string }>
}) {
  const who = await requireUser()

  const { ledgerId, kind } = await params
  const q = await searchParams
  if (!REGISTER_KINDS.includes(kind as RegisterKind)) notFound()

  const asOf = q.asOf ?? localToday()
  const audience: Audience = q.audience === 'public' ? 'public' : 'director'

  const [rendered, data] = await Promise.all([
    renderRegisterForLedger(kind as RegisterKind, ledgerId, asOf, audience),
    recordsScreenData(ledgerId),
  ])
  if (!rendered) notFound()
  const { register, entityId } = rendered
  await logRegisterExport({
    entityId, kind: kind as RegisterKind, asOf, audience, actor: actorOf(who),
  })

  return (
    <main className="mx-auto w-full max-w-none px-8 py-10 font-sans">
      <div className="no-print">
        <Link href={`/ledger/${ledgerId}/records`}
              className={TOOL_BUTTON} title="Back"><ToolAction kind="back">Back to Corporate records</ToolAction></Link>
        <form className="mt-3 flex items-end gap-3 text-xs text-neutral-500">
          <label className="flex flex-col gap-1">
            As at
            <DateInput name="asOf" defaultValue={asOf}
                   className={FIELD} />
          </label>
          <label className="flex flex-col gap-1">
            Audience
            <select name="audience" defaultValue={audience}
                    className={FIELD}>
              <option value="director">Director</option>
              <option value="public">Public</option>
            </select>
          </label>
          <button className="rounded border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900">
            Re-render
          </button>
        </form>
      </div>

      <div className="mt-6">
        <RegisterView register={register}
          pdfHref={`/ledger/${ledgerId}/records/register/${kind}/pdf?asOf=${asOf}&audience=${audience}`} />
      </div>

      {/* The register's own management (owner, 2026-09-03): the add-and-cease
          doors live under the paper they change — the same gated component
          the Basic Info page renders, so there is ONE form definition. */}
      {data && audience === 'director' && (
        <div className="no-print mt-4 border-t border-neutral-200 dark:border-neutral-800">
          <RecordsPanel ledgerId={ledgerId} show={MANAGE[kind as RegisterKind]} data={data} />
        </div>
      )}
    </main>
  )
}
