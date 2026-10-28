import Link from 'next/link'
import { cookies } from 'next/headers'
import { requireLedger,SESSION_COOKIE } from '@/lib/gate'
import { planningActor } from '@/lib/planning-access'
import { importDetail } from '@/lib/ledger-import'
import { planningLists } from '@/lib/budgets'
import { PlanningShell } from '@/components/PlanningShell'
import { planningAction } from '@/app/planning-actions'
import { MigrationEditor } from '../MigrationForm'
import { formatMoney } from '@/lib/money'
export const dynamic='force-dynamic'
export default async function MigrationRun({params}:{params:Promise<{ledgerId:string;runId:string}>}) {
 const {ledgerId,runId}=await params;await requireLedger(ledgerId,'/opening');const actor=planningActor((await cookies()).get(SESSION_COOKIE)?.value??'')
 const d=await importDetail(ledgerId,runId,actor),lists=await planningLists(ledgerId,actor,'/opening'),validation=d.run.validation as {issues?:Array<{level:string;code:string;message:string;fileId?:string;sourceLines?:number[]}>;coverage?:Record<string,string>;openingDelta?:Array<{accountId:string;amount:string}>}
 return <PlanningShell ledgerId={ledgerId} title="Migration review" back="/opening/migration">
 <p className="my-4">{d.run.mode} · <strong>{d.run.status}</strong> · {d.run.source_system} / {d.run.source_company} · {d.run.currency} · {d.run.from_date} — {d.run.cutoff_date}</p>
 <ol className="mb-5 flex flex-wrap gap-3 text-sm"><li>1. Stage CSV</li><li>2. Map accounts / parties</li><li>3. Validate & review</li><li>4. Approve & run batches</li><li>5. Reconcile & activate</li></ol>
 {d.run.last_error&&<p role="alert" className="mb-4 text-sm">{d.run.last_error}</p>}
 <MigrationEditor ledgerId={ledgerId} detail={d} lists={lists} action={planningAction}/>
 <h2 className="mb-2 mt-8 font-medium">Source files</h2><ul>{d.files.map(f=><li key={f.id} className="py-2 text-sm"><a className="underline" href={`/ledger/${ledgerId}/opening/migration/${runId}/source/${f.id}`}>{f.filename}</a> · {f.kind} · {f.row_count} staged rows · {f.excluded_rows.length} excluded · SHA-256 <span className="break-all font-mono">{f.sha256}</span></li>)}</ul>
 <h2 className="mb-2 mt-6 font-medium">Validation & coverage</h2><a className="text-sm underline" href={`/ledger/${ledgerId}/opening/migration/${runId}/issues`}>Download source-row errors CSV</a>
 <ul className="mt-3">{validation.issues?.map((i,n)=><li key={n} className="mb-2 text-sm">{i.level} · {i.code} · {i.message}{i.sourceLines?.length?' · source lines '+i.sourceLines.join(', '):''}</li>)}</ul>
 <dl className="my-4 grid gap-2 sm:grid-cols-2">{Object.entries(validation.coverage??{}).map(([key,value])=><div key={key} className="text-sm"><dt className="inline font-medium">{key}: </dt><dd className="inline">{value}</dd></div>)}</dl>
 <h2 className="mb-2 font-medium">Opening delta</h2><ul className="text-sm">{validation.openingDelta?.map(l=><li key={l.accountId}>{lists.accounts.find(a=>a.id===l.accountId)?.code} · {formatMoney(BigInt(l.amount))}</li>)}</ul>
 <h2 className="mb-2 mt-6 font-medium">Reconciliation</h2>{d.run.reconciliation?<pre className="overflow-x-auto whitespace-pre-wrap rounded-control border border-line p-4 text-xs">{JSON.stringify(d.run.reconciliation,null,2)}</pre>:<p className="text-sm">No completed reconciliation yet. Intermediate data are incomplete.</p>}
 <h2 className="mb-2 mt-6 font-medium">Committed source references</h2><div className="divide-y divide-line">{d.completed.map(c=><div key={c.source_key} className="flex flex-wrap gap-3 py-2 text-sm"><span>{c.source_key}</span><span>{c.source_rows.map(row=>(d.files.find(f=>f.id===row.fileId)?.filename??row.fileId)+' line '+row.line).join('; ')}</span>{c.invoice_id?<Link className="underline" href={`/ledger/${ledgerId}/invoices/${c.invoice_id}`}>Document</Link>:c.entry_id?<Link className="underline" href={`/ledger/${ledgerId}/entries/${c.entry_id}`}>Journal</Link>:null}</div>)}</div>
 </PlanningShell>
}
