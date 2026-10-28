
import { PageHeading } from '@/components/DialogHeading'
import { requireUser } from '@/lib/gate'
import { notFound } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { SENTENCE_MAX, readingCards, readingsFor } from '@/lib/bill-reading'
import { panelStateFrom, serviceState } from '@/lib/ai-service'
import { discardReadingAction, readBillAction } from '@/app/actions'
import { ReadBill } from '@/components/ReadBill'
import { ledgerHead } from '@/lib/ledger-head'
import { refuseForLedger } from '@/lib/access'
import { AiModeNav } from '@/components/AiModeNav'
import { AiServiceStatus } from '@/components/AiServiceStatus'

export const dynamic = 'force-dynamic'

/**
 * Read & add — one mode in the shared + AI workspace.
 *
 * The reader started on the Assistant page, moved onto Expenses and Invoices
 * on 2026-09-07 because reading a bill is something you do while entering
 * money, and moved again the same day: the owner found it in the way at the
 * bottom of two browse screens and asked for a button
 * (「把它做一个新的 +AI Add 的按钮吧」). In 2026-09 it joined the ERP Skill
 * Assistant behind one + AI control beside + Add. The workflows remain
 * separate here because a document proposal must still pass through review.
 *
 * ONE component still, and one AI workspace: `ReadBill` is not on Expenses or
 * Invoices any more. Two copies of it were the price of it being on two
 * screens; a door of its own does not need to pay that.
 *
 * The seat is not a new one. `/readings` remains a declared detail route opened by
 * `/expenses`, `/invoices` or `/assistant` (`nav.ts`) — the same seats that
 * could reach the reader before this moved.
 */
export const metadata = { title: 'AI' }

export default async function Readings({ params }: { params: Promise<{ ledgerId: string }> }) {
  const me = await requireUser()
  const { ledgerId } = await params

  const head = await ledgerHead(ledgerId)
  if (!head) notFound()

  const [service, readings, chartRows, askRefusal] = await Promise.all([
    serviceState(me.id),
    readingsFor(ledgerId),
    db.execute<{ code: string; name: string }>(sql`
      SELECT a.code, a.name FROM account a
       WHERE a.entity_id = (SELECT entity_id FROM ledger WHERE id = ${ledgerId}::uuid)`),
    refuseForLedger(me, ledgerId, '/assistant'),
  ])
  const chart = Object.fromEntries(chartRows.map((a) => [a.code, `${a.code} — ${a.name}`]))

  return (
    <main className="mx-auto w-full max-w-none px-8 py-10 font-sans">
      <PageHeading className="mt-2" title={<>AI</>} />
      <div className="mt-1 flex flex-wrap gap-x-1 text-sm text-neutral-500">
        <p>{head.entity}</p>

      </div>
      <AiModeNav ledgerId={ledgerId} active="read" showAsk={askRefusal === null} showInbox={!(await refuseForLedger(me,ledgerId,'/automation'))}/>
      <AiServiceStatus ledgerId={ledgerId} state={panelStateFrom(service)} />
      {readings.length >= 10 && (
        <p className="mt-2 text-xs text-neutral-500">
          The newest 10 readings are shown; older ones stay in the books they were entered into.
        </p>
      )}
      <ReadBill ledgerId={ledgerId} canRead={service.kind === 'ready'} chart={chart}
                readings={readingCards(readings)} sentenceMax={SENTENCE_MAX}
                readAction={readBillAction} discardAction={discardReadingAction} />
    </main>
  )
}
