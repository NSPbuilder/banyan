import {requireLedger} from '@/lib/gate'
import Link from 'next/link'
import {notFound} from 'next/navigation'
import {ledgerHead} from '@/lib/ledger-head'
import {assetRows} from '@/lib/assets'
import {ccaRegister} from '@/lib/cca'
import {formatMoney} from '@/lib/money'
import {localToday} from '@/lib/today'
import {PageHeader} from '@/components/PageHeader'
import {TableViewport,DataTable} from '@/components/Table'
import {TABLE_ACTION} from '@/lib/ui'
import {CcaPolicy} from '../CcaPolicy'
import {CcaPoolForm,CcaAssignmentForm} from '../CcaForms'
import {ccaPoolAction,ccaAssignmentAction} from '../actions'
export const dynamic='force-dynamic'
export default async function CcaPage({params}:{params:Promise<{ledgerId:string}>}){const {ledgerId}=await params;await requireLedger(ledgerId,'/assets');const [head,assets,register]=await Promise.all([ledgerHead(ledgerId),assetRows(ledgerId),ccaRegister(ledgerId)]);if(!head)notFound();const {pools,assignments}=register
 return <div className="space-y-6" data-operations-screen="cca"><PageHeader title="Canadian CCA" context={`${head.entity} · Tax register in CAD`}>{pools.length>0&&assets.some(a=>!assignments.some(x=>x.asset_id===a.id))&&<CcaAssignmentForm ledgerId={ledgerId} assets={assets.filter(a=>!assignments.some(x=>x.asset_id===a.id))} pools={pools} currency={head.currency} action={ccaAssignmentAction}/>}<CcaPoolForm ledgerId={ledgerId} today={localToday()} action={ccaPoolAction}/></PageHeader><p className="text-body text-ink-secondary max-w-prose">Manage tax classes and annual claims separately from book depreciation. Enter CAD tax bases after business-use allocations and cost limits, then choose and document the applicable first-year rule.</p><TableViewport label="CCA tax pools"><DataTable className="ui-table-spaced min-w-192"><thead><tr><th>Pool / class</th><th>Rate / calculation</th><th className="text-right">UCC (CAD)</th><th>Last recorded year</th><th>Assets</th></tr></thead><tbody>{pools.map(p=><tr key={p.id}><td><Link className={TABLE_ACTION} href={`/ledger/${ledgerId}/assets/cca/${p.id}`}>{p.name}</Link><p className="text-metadata text-ink-muted">Class {p.class_code}</p></td><td>{p.rate_bp/100}%<p className="text-metadata text-ink-muted">{p.calculation==='standard'?'Standard declining balance':'Reviewed manual'}</p></td><td className="text-right tabular-nums">{formatMoney(BigInt(p.latest_closing??p.opening_ucc))}</td><td>{p.latest_end??'Opening balance only'}</td><td>{assignments.filter(a=>a.pool_id===p.id).length}</td></tr>)}{!pools.length&&<tr><td colSpan={5} className="py-10 text-center text-ink-muted">Create a tax pool, assign assets, then review the first tax year.</td></tr>}</tbody></DataTable></TableViewport><CcaPolicy/></div>
}
