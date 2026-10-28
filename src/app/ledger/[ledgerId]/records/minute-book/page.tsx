import { notFound } from 'next/navigation'
import { requireUser } from '@/lib/gate'
import { ledgerHead } from '@/lib/ledger-head'
import { localToday } from '@/lib/today'
import { minuteBookOf } from '@/lib/records'
import { minuteBookPaperOf } from '@/modules/records/attachments'
import { minuteKinds } from '@/lib/record-forms'
import { MinuteBookScreen } from './MinuteBookScreen'

export const dynamic = 'force-dynamic'

export default async function Page({ params, searchParams }: {
  params: Promise<{ ledgerId: string }>; searchParams: Promise<{ q?: string }>
}) {
  await requireUser()
  const { ledgerId } = await params
  const head = await ledgerHead(ledgerId)
  if (!head) notFound()
  const [records, paper, kinds] = await Promise.all([minuteBookOf(head.entity_id), minuteBookPaperOf(head.entity_id), minuteKinds()])
  const byRecord = new Map<string, typeof paper>()
  for (const p of paper) {
    const group = byRecord.get(p.minute_book_entry_id) ?? []
    group.push(p); byRecord.set(p.minute_book_entry_id, group)
  }
  return <main className="mx-auto w-full max-w-none px-8 py-10 font-sans">
    <MinuteBookScreen ledgerId={ledgerId} entity={head.entity} today={localToday()} kinds={kinds} initialQuery={(await searchParams).q ?? ''}
      records={records.map(r => ({ ...r, papers: (byRecord.get(r.id) ?? []).map(p => ({
        id: p.id, filename: p.filename, uploaded: p.uploaded, byte_size: p.byte_size, mime: p.mime,
      })) }))} />
  </main>
}
