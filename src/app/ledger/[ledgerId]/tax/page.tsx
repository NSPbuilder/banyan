import { requireUser } from '@/lib/gate'
import { notFound } from 'next/navigation'
import { filingPeriods, gstHstReturn } from '@/lib/tax'
import { FiguresRead } from '@/components/FiguresRead'
import { localToday } from '@/lib/today'
import { formatMoney } from '@/lib/money'
import { ReturnScreen } from './ReturnScreen'
import { GstAdjustments } from './GstAdjustments'
import { saveGstAdjustmentsAction } from './actions'

export const dynamic = 'force-dynamic'

/** CRA's GST/HST return, the lines and the entries behind each. */
export default async function Tax({
  params, searchParams,
}: {
  params: Promise<{ ledgerId: string }>
  searchParams: Promise<{ from?: string; to?: string; show?: string }>
}) {
  await requireUser()
  const { ledgerId } = await params
  const { from: wantFrom, to: wantTo, show } = await searchParams

  const choices = filingPeriods()
  const from = wantFrom ?? choices[0].from
  const to = wantTo ?? choices[0].to
  const gst = await gstHstReturn(ledgerId, from, to)
  if (!gst) notFound()
  const { lines } = gst
  const refund = lines.net.amount < 0n

  return (
    <ReturnScreen
      ledgerId={ledgerId} ret={gst} label="GST/HST"
      lines={[lines.sales, lines.collected, lines.itcs, lines.net]}
      title="GST/HST return" path="/tax" exportWhat="gst-hst" pdfQuery=""
      choices={choices} from={from} to={to} show={show}
      extra={<FiguresRead on={to} today={localToday()} />}
      controls={<GstAdjustments key={`${from}:${to}:${gst.adjustment?.version ?? 0}`} ledgerId={ledgerId} from={from} to={to}
        books={{ sales: String(lines.sales.bookAmount ?? lines.sales.amount), collected: String(lines.collected.bookAmount ?? lines.collected.amount), itcs: String(lines.itcs.bookAmount ?? lines.itcs.amount) }}
        saved={gst.adjustment ?? null} action={saveGstAdjustmentsAction} />}
      blurb="The figures for CRA's form, and the entries behind each one. Nothing is filed from here — copy the numbers onto your return."
      verdict={lines.net.amount === 0n
        ? 'Nothing to pay and nothing to claim for this period.'
        : refund
          ? <><strong>{formatMoney(-lines.net.amount)} to claim</strong> — your input tax
              credits exceed the tax you collected, so line 114 is a refund.</>
          : <><strong>{formatMoney(lines.net.amount)} to pay</strong> — line 115 on the return.</>}
      footnote={<>Posted entries only; drafts appear nowhere. Line 101 is revenue, which excludes the tax
        because the tax is posted to its own account. Lines 105 and 108 are the movement on the
        accounts tagged &ldquo;GST/HST payable&rdquo; and &ldquo;GST/HST recoverable&rdquo; — if a
        figure looks wrong, open the entries behind it.</>}
    />
  )
}
