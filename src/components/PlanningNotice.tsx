import Link from 'next/link'
import { migrationNotice } from '@/lib/ledger-import'
export async function PlanningNotice({ledgerId}:{ledgerId:string}) {
 const notice=await migrationNotice(ledgerId)
 return notice?<p role="status" className="border-b border-line bg-paper px-8 py-3 text-sm">{notice.text} <Link href={`/ledger/${ledgerId}/opening/migration/${notice.id}`} className="underline">Migration report</Link></p>:null
}
