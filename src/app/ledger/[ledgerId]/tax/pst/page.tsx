import { requireUser } from '@/lib/gate'
import { notFound } from 'next/navigation'
import { filingPeriods, pstReturn } from '@/lib/tax'
import { FiguresRead } from '@/components/FiguresRead'
import { localToday } from '@/lib/today'
import { formatMoney } from '@/lib/money'
import Link from 'next/link'
import { ReturnScreen } from '../ReturnScreen'

export const dynamic = 'force-dynamic'

/** BC's PST return (FIN 400), the boxes and the entries behind each. */
export default async function Pst({
  params, searchParams,
}: {
  params: Promise<{ ledgerId: string }>
  searchParams: Promise<{ from?: string; to?: string; show?: string; late?: string }>
}) {
  await requireUser()
  const { ledgerId } = await params
  const { from: wantFrom, to: wantTo, show, late } = await searchParams

  const choices = filingPeriods()
  const from = wantFrom ?? choices[0].from
  const to = wantTo ?? choices[0].to
  const ret = await pstReturn(ledgerId, from, to, { late: late === '1' })
  if (!ret) notFound()
  const { lines } = ret

  return (
    <ReturnScreen
      ledgerId={ledgerId} ret={ret} label="PST"
      lines={[lines.sales, lines.collected, lines.commission, lines.net]}
      title="PST return" path="/tax/pst" exportWhat="pst" pdfQuery={`&tax=pst${late === '1' ? '&late=1' : ''}`}
      extra={<><Link href={`/ledger/${ledgerId}/tax/pst?from=${from}&to=${to}${late === '1' ? '' : '&late=1'}`}
                   className="text-xs text-neutral-500 hover:underline">
        {late === '1' ? 'Filed on time after all — put the commission back' : 'Filing late? Take the commission off'}
      </Link>
      <span className="ml-3"><FiguresRead on={to} today={localToday()} /></span></>}
      choices={choices} from={from} to={to} show={show}
      blurb="The figures for BC's return, and the entries behind each one. Nothing is filed from here — copy the numbers onto your return."
      verdict={lines.net.amount === 0n
        ? 'Nothing to pay for this period.'
        : <><strong>{formatMoney(lines.net.amount)} to pay</strong> — box B less the commission in box C, which BC allows only when the return is filed and paid on time.</>}
      footnote={<>Posted entries only; drafts appear nowhere. Box A is revenue, which excludes the tax
        because the tax is posted to its own account. Box B is the movement on the account tagged
        &ldquo;QST/PST payable&rdquo; — if a figure looks wrong, open the entries behind it. Most
        services are PST-exempt, so a sale with no PST on it is not flagged here.</>}
    />
  )
}
