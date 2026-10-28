import type { ProjectLine, ProjectRecordRow } from './project'

export const PROJECT_CATEGORIES = ['revenue','labor','subcontractor','material','janitorial','delivery','other'] as const
export type ProjectCategory = typeof PROJECT_CATEGORIES[number]
export const PROJECT_COST_CATEGORIES = ['material','labor','subcontractor','janitorial','delivery','other'] as const satisfies readonly ProjectCategory[]
export const PROJECT_CATEGORY_NAMES:Record<ProjectCategory,string> = {revenue:'Revenue',labor:'Labour',subcontractor:'Labour (subcontractor)',material:'Material',janitorial:'Janitorial',delivery:'Delivery',other:'Other'}
export const PROJECT_AMOUNT_KEYS = ['base','gst','pst','gross','recoverGST','recoverPST','nonrecoverGST','nonrecoverPST','pendingGST','pendingPST'] as const
export type ProjectAmounts=Record<typeof PROJECT_AMOUNT_KEYS[number],bigint>
export function emptyProjectAmounts():ProjectAmounts {
  return {base:0n,gst:0n,pst:0n,gross:0n,recoverGST:0n,recoverPST:0n,nonrecoverGST:0n,nonrecoverPST:0n,pendingGST:0n,pendingPST:0n}
}
export function projectLineAmounts(lines:ProjectRecordRow['lines'],cost:boolean):ProjectAmounts {
  const t=emptyProjectAmounts()
  for(const l of lines) {
    const base=BigInt(l.base),gst=BigInt(l.gst),pst=BigInt(l.pst)
    t.base+=base;t.gst+=gst;t.pst+=pst;t.gross+=base+gst+pst
    if(cost) {
      if(l.gstRecoverable===null)t.pendingGST+=gst
      else {t.recoverGST+=BigInt(l.gstRecoverable);t.nonrecoverGST+=gst-BigInt(l.gstRecoverable)}
      if(l.pstRecoverable===null)t.pendingPST+=pst
      else {t.recoverPST+=BigInt(l.pstRecoverable);t.nonrecoverPST+=pst-BigInt(l.pstRecoverable)}
    }
  }
  return t
}
export function projectSheetSummary(records:ProjectRecordRow[]) {
  const totals=Object.fromEntries(PROJECT_CATEGORIES.map(k=>[k,emptyProjectAmounts()])) as Record<ProjectLine['kind'],ProjectAmounts>
  for(const r of records)for(const line of r.lines) {
    const t=projectLineAmounts([line],r.kind==='cost')
    for(const k of PROJECT_AMOUNT_KEYS)totals[line.kind][k]+=t[k]
  }
  return totals
}
export function projectRecordType(record:Pick<ProjectRecordRow,'kind'|'lines'>) {
  if(record.kind==='revenue')return 'Revenue'
  return 'Cost · '+PROJECT_CATEGORIES.filter(k=>record.lines.some(l=>l.kind===k)).map(k=>PROJECT_CATEGORY_NAMES[k]).join(' / ')
}
export type ProjectAccountingRow=ProjectAmounts & {projectId:string;partyId:string|null;party:string;type:string;kind:string;settled:bigint;outstanding:bigint;count:number}
export function projectAccountingGroups(records:ProjectRecordRow[]):ProjectAccountingRow[] {
  const groups=new Map<string,ProjectAccountingRow>()
  for(const r of records) {
    // Settlement belongs to a whole record. Keep mixed-category records in
    // their own labelled group rather than inventing a per-line allocation.
    const type=projectRecordType(r),key=JSON.stringify([r.project_id,type,r.party_id])
    const row=groups.get(key)||{...emptyProjectAmounts(),projectId:r.project_id,partyId:r.party_id,party:r.party,type,kind:r.kind,settled:0n,outstanding:0n,count:0}
    const t=projectLineAmounts(r.lines,r.kind==='cost')
    for(const k of PROJECT_AMOUNT_KEYS)row[k]+=t[k]
    row.settled+=BigInt(r.settled);row.outstanding+=BigInt(r.outstanding);row.count++
    groups.set(key,row)
  }
  return [...groups.values()].sort((a,b)=>a.projectId.localeCompare(b.projectId)||(a.kind===b.kind?0:a.kind==='revenue'?-1:1)||a.type.localeCompare(b.type)||a.party.localeCompare(b.party))
}
export function projectAccountingTotal(rows:ProjectAccountingRow[],kind:'revenue'|'cost') {
  const t={...emptyProjectAmounts(),settled:0n,outstanding:0n,count:0}
  for(const r of rows)if(r.kind===kind) {
    for(const k of PROJECT_AMOUNT_KEYS)t[k]+=r[k]
    t.settled+=r.settled;t.outstanding+=r.outstanding;t.count+=r.count
  }
  return t
}

/** Sales GST/PST are collected taxes, not revenue. Only confirmed
 * non-recoverable cost PST belongs in this basis; GST is shown separately.
 * An unknown recovery amount must never silently become zero or a cost. */
export function projectProfitBasis(amounts:ProjectAmounts,kind:'revenue'|'cost'):bigint|null {
  if(kind==='revenue')return amounts.base
  return amounts.pendingPST>0n?null:amounts.base+amounts.nonrecoverPST
}
export function projectAccountingProfit(rows:ProjectAccountingRow[]) {
  const revenue=projectAccountingTotal(rows,'revenue'),cost=projectAccountingTotal(rows,'cost')
  const basis=projectProfitBasis(cost,'cost')
  const beforeGST=basis===null?null:revenue.base-basis
  return {beforeTax:revenue.base-cost.base,beforeGST,
    adjusted:beforeGST===null||cost.pendingGST>0n?null:beforeGST-cost.nonrecoverGST,cost}
}
