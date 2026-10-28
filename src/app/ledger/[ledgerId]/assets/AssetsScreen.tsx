'use client'
import { useState } from 'react'
import Link from 'next/link'
import {RegisterSummary} from '@/components/OperationsWorkspace'
import {DEPRECIATION_METHODS,type DepreciationAsset,type CcaPool,type CcaAssignment} from '@/lib/depreciation-types'
import { PageHeader } from '@/components/PageHeader'
import { FilterBar } from '@/components/FormLayout'
import { ColumnTable, TableViewport } from '@/components/Table'
import { FIELD, LABEL, QUIET, TABLE_ACTION } from '@/lib/ui'
import { formatMoney } from '@/lib/money'
import type { AssetRow } from '@/lib/asset-types'
import type { FormAction } from '@/components/ActionForm'
import { AssetForm } from './AssetForms'
import { ASSET_STATUSES } from '@/lib/asset-types'
import type {FinanceSetting,FundingOption} from '@/lib/operations-finance-types'

export function AssetsScreen({ledgerId,entity,currency,today,assets,saveAction,depreciation=[],pools=[],assignments=[],finance,accounts=[],requestKey}:{ledgerId:string;entity:string;currency:string;today:string;assets:AssetRow[];saveAction:FormAction;depreciation?:DepreciationAsset[];pools?:CcaPool[];assignments?:CcaAssignment[];finance:FinanceSetting|null;accounts:FundingOption[];requestKey:string}) {
  const [search,setSearch]=useState(''),[status,setStatus]=useState(''),[category,setCategory]=useState('')
  const categories=[...new Set(assets.map(a=>a.category).filter(Boolean))].sort()
  const visible=assets.filter(a=>(!status||a.status===status)&&(!category||a.category===category)&&[a.code,a.name,a.serial_number,a.location,a.custodian].join(' ').toLowerCase().includes(search.toLowerCase()))
  const active=assets.filter(a=>a.status!=='disposed'),cost=active.reduce((n,a)=>n+BigInt(a.acquisition_cost),0n)
  const book=(id:string)=>depreciation.find(a=>a.id===id),accumulated=active.reduce((n,a)=>n+BigInt(book(a.id)?.accumulated??'0'),0n)
  return <div className="space-y-6" data-operations-screen="assets">
    <PageHeader title="Fixed assets" context={entity}><Link href={`/ledger/${ledgerId}/assets/depreciation`} className={QUIET}>Review depreciation</Link><a href={`/ledger/${ledgerId}/assets/export`} className={QUIET}>Export CSV</a>{finance?.connected_on?<AssetForm ledgerId={ledgerId} currency={currency} today={today} pools={pools} action={saveAction} finance={finance} accounts={accounts} requestKey={requestKey}/>:<Link className={QUIET} href={`/ledger/${ledgerId}/assets/finance`}>Connect Finance</Link>}</PageHeader>
    {!finance?.connected_on&&<p className="border-l-3 border-action pl-4 text-body text-ink-secondary">Review opening balances in <Link className="underline" href={`/ledger/${ledgerId}/assets/finance`}>Finance</Link> before adding financed assets. Existing asset records are retained.</p>}
    <RegisterSummary label="Asset register summary" values={[{label:`Acquisition cost · ${currency}`,value:formatMoney(cost)},{label:`Accumulated depreciation · ${currency}`,value:formatMoney(accumulated)},{label:`Net book value · ${currency}`,value:formatMoney(cost-accumulated)}]}/>
    <FilterBar><label className={LABEL}>Search<input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Code, name, serial or custodian" className={`${FIELD} mt-1 block w-64 max-w-full`}/></label>
      <label className={LABEL}>Status<select aria-label="Status" value={status} onChange={e=>setStatus(e.target.value)} className={`${FIELD} mt-1 block w-40`}><option value="">All statuses</option>{Object.entries(ASSET_STATUSES).map(([key,text])=><option key={key} value={key}>{text}</option>)}</select></label>
      <label className={LABEL}>Category<select aria-label="Category" value={category} onChange={e=>setCategory(e.target.value)} className={`${FIELD} mt-1 block w-44`}><option value="">All categories</option>{categories.map(c=><option key={c}>{c}</option>)}</select></label>
    </FilterBar>
    <TableViewport label="Fixed asset register"><ColumnTable className="ui-table-spaced min-w-248" columns={[{width:'22%'},{width:'15%'},{width:'15%'},{width:'15%'},{width:'13%'},{width:'13%'},{width:'7%'}]}>
      <thead><tr><th>Asset</th><th>Location / custodian</th><th>Book policy</th><th>CCA pool</th><th className="text-right">Accumulated ({currency})</th><th className="text-right">Net book value ({currency})</th><th>Status</th></tr></thead><tbody>
        {visible.map(a=><tr key={a.id}><td><Link href={`/ledger/${ledgerId}/assets/${a.id}`} className={TABLE_ACTION}>{a.name}</Link><p className="text-metadata text-ink-muted">{a.code}{a.serial_number&&` · ${a.serial_number}`}</p></td><td>{a.location||'—'}{a.custodian&&<p className="text-metadata text-ink-muted">{a.custodian}</p>}</td><td>{book(a.id)?.policy?DEPRECIATION_METHODS[book(a.id)!.policy!.method]:'Not configured'}</td><td>{assignments.find(x=>x.asset_id===a.id)?<Link className={TABLE_ACTION} href={`/ledger/${ledgerId}/assets/cca/${assignments.find(x=>x.asset_id===a.id)!.pool_id}`}>{pools.find(p=>p.id===assignments.find(x=>x.asset_id===a.id)!.pool_id)?.name}</Link>:'Not assigned'}</td><td className="text-right tabular-nums whitespace-nowrap">{formatMoney(BigInt(book(a.id)?.accumulated??'0'))}</td><td className="text-right tabular-nums whitespace-nowrap">{formatMoney(BigInt(book(a.id)?.net_book_value??a.acquisition_cost))}</td><td>{ASSET_STATUSES[a.status]}</td></tr>)}
        {!visible.length&&<tr><td colSpan={7} className="py-10 text-center text-ink-muted">{assets.length?'No assets match these filters.':'Add your first asset to track acquisition, custody and maintenance.'}</td></tr>}
      </tbody></ColumnTable></TableViewport>
    <p className="text-metadata text-ink-muted">{visible.length} of {assets.length} assets. Balances reflect recorded book depreciation. Review monthly depreciation and CAD tax pools from their tabs.</p>
  </div>
}
