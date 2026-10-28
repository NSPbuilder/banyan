import 'server-only'
import ExcelJS from 'exceljs'
import { csvFile, csvMoney } from './csv'
import { projectSummaries, projectRecords, projectPayments, projectAllocations, projectCostTotals, projectProfit, type ProjectFilters } from './project'
import { projectAttachments } from './project-attachments'
import { projectAccountingGroups, projectAccountingTotal, projectProfitBasis, projectAccountingProfit } from './project-accounting'

type Cell = string | number
export async function projectExport(entityId:string,company:string,filters:ProjectFilters,project?:string,kind='summary',format='csv') {
  const [summaries,records,payments,balances,allocations,attachments]=await Promise.all([projectSummaries(entityId,project?{from:filters.from,to:filters.to}:filters,project),projectRecords(entityId,filters,project),projectPayments(entityId,filters,project),projectRecords(entityId,{...filters,from:undefined},project),projectAllocations(entityId,project),projectAttachments(entityId,project)])
  const names=new Map(summaries.map(p=>[p.id,p.code]))
  const currencies=new Map(summaries.map(p=>[p.id,p.currency]))
  const balanceIDs=new Set(balances.map(r=>r.id))
  const allocationRows=allocations.filter(a=>balanceIDs.has(a.record_id)&&(!filters.from||a.effective_date>=filters.from)&&(!filters.to||a.effective_date<=filters.to))
  const fileCounts=new Map<string,number>()
  for(const a of attachments)for(const key of ['project_id','record_id','payment_id'] as const)if(a[key]) {const k=key+':'+a[key];fileCounts.set(k,(fileCounts.get(k)||0)+1)}
  const attachmentCount=(key:'project_id'|'record_id'|'payment_id',id:string)=>fileCounts.get(key+':'+id)||0
  const metadata:Cell[][]=[['Company',company],['Generated at',new Date().toISOString()],['Revenue basis','Recorded revenue less material, labor, subcontractor, janitorial, delivery and other project costs'],
    ['Record dates',`${filters.from||'Lifetime start'} through ${filters.to||'All dates'}`],['Cash dates','Payment date in the same range'],['Balances as of',filters.to||'All recorded dates'],
    ['Filters',JSON.stringify(filters)],['Allocation dates','Effective date, in the same range; matched to filtered as-of records.'],['Tax scope','Tax sheet totals matching cost records in full, including mixed categories.'],['Accounting scope','Classification combination + Party; mixed records stay whole, with no invented per-line settlement. Paid/outstanding are as-of figures on matching records.'],['Amounts','Exact decimal text; currency is specified per project. Pending taxes prevent adjusted profit.'],['Profit basis','Revenue Net excludes collected GST/PST. Cost basis is Net plus confirmed non-recoverable PST; pending PST prevents profit before GST. Non-recoverable GST is deducted separately.']]
  const tables:Record<string,Cell[][]>={
    balances:[['Project','Currency','Record ID','Kind','Party','Record date','Gross','Allocated as of','Outstanding as of'],...balances.map(r=>[names.get(r.project_id)||r.project_id,currencies.get(r.project_id)||'',r.id,r.kind,r.party,r.record_date,...[r.gross,r.settled,r.outstanding].map(csvMoney)])],
    summary:[['Project','Name','Customer','Status','Currency','Revenue','Material','Labor','Subcontractor','Janitorial','Delivery','Other','Input GST','Input PST','Output GST','Output PST','Confirmed non-recoverable tax','Pending tax','Gross profit','Adjusted gross profit','Received','Paid','Net cash movement','Receivable as of','Payable as of','Customer advance','Supplier advance'],
      ...summaries.map(p=>{const n=projectProfit(p);return [p.code,p.name,p.customer,p.status,p.currency,...[p.revenue,p.material,p.labor,p.subcontractor,p.janitorial,p.delivery,p.other,p.input_gst,p.input_pst,p.output_gst,p.output_pst,p.nonrecoverable,p.pending_tax].map(csvMoney),csvMoney(n.before),n.adjusted===null?'Pending tax review':csvMoney(n.adjusted),csvMoney(p.received),csvMoney(p.paid),csvMoney(n.cash),...['receivable','payable','customer_advance','supplier_advance'].map(k=>csvMoney(p[k as keyof typeof p] as string))]})],
    accounting:[['Project','Currency','Type','Party','Record count','Net','Net + cost PST','GST','PST','Total','Paid / received as of','Outstanding as of','Tax review'],
      ...summaries.flatMap(p=>{
        const groups=projectAccountingGroups(records.filter(r=>r.project_id===p.id))
        const row=(type:string,party:string,g:ReturnType<typeof projectAccountingTotal>,kind:'revenue'|'cost'):Cell[]=>{
          const basis=projectProfitBasis(g,kind)
          return [p.code,p.currency,type,party,g.count,csvMoney(g.base),basis===null?'Pending PST review':csvMoney(basis),...[g.gst,g.pst,g.gross,g.settled,g.outstanding].map(csvMoney),g.pendingGST+g.pendingPST>0n?'Pending':'Confirmed / not applicable']
        }
        const profit=projectAccountingProfit(groups)
        return [...groups.map(g=>row(g.type,g.party,g,g.kind as 'revenue'|'cost')),...(['revenue','cost'] as const).map(k=>row(k==='revenue'?'Revenue total':'Cost total','',projectAccountingTotal(groups,k),k)),
          [p.code,p.currency,'Profit before tax','','',csvMoney(profit.beforeTax),'','','','','','',''],
          [p.code,p.currency,'Profit before GST','','','',profit.beforeGST===null?'Pending PST review':csvMoney(profit.beforeGST),'','','','','',''],
          ...(profit.cost.nonrecoverGST>0n||profit.cost.pendingGST>0n?[[p.code,p.currency,'After non-recoverable GST','','','',profit.adjusted===null?'Pending tax review':csvMoney(profit.adjusted),'','','','','','']]:[])]
      })],
    records:[['Project','Currency','Record ID','Kind','Party','Record date','Due date','Reference','Description','Base','GST','PST','Gross','Allocated as of','Outstanding as of','Pending tax'],
      ...records.map(r=>[names.get(r.project_id)||r.project_id,currencies.get(r.project_id)||'',r.id,r.kind,r.party,r.record_date,r.due_date||'',r.reference||'',r.description,...[r.base,r.gst,r.pst,r.gross,r.settled,r.outstanding,r.pending_tax].map(csvMoney)])],
    lines:[['Project','Currency','Record ID','Party','Record date','Kind','Description','Base','GST','PST','GST recoverable','PST recoverable'],
      ...records.flatMap(r=>r.lines.map(l=>[names.get(r.project_id)||r.project_id,currencies.get(r.project_id)||'',r.id,r.party,r.record_date,l.kind,l.description,...[l.base,l.gst,l.pst].map(csvMoney),l.gstRecoverable===null?(r.kind==='cost'?'Pending':'Not applicable'):csvMoney(l.gstRecoverable),l.pstRecoverable===null?(r.kind==='cost'?'Pending':'Not applicable'):csvMoney(l.pstRecoverable)]))],
    payments:[['Project','Currency','Payment ID','Direction','Party','Payment date','Reference','Method','Amount','Allocated as of','Unallocated as of'],
      ...payments.map(p=>[names.get(p.project_id)||p.project_id,currencies.get(p.project_id)||'',p.id,p.direction,p.party,p.payment_date,p.reference||'',p.method||'',...[p.amount,p.allocated,p.unallocated].map(csvMoney)])],
    parties:[['Project','Currency','Party','Kind','Base','GST','PST','Gross','Allocated','Outstanding'],...Array.from(records.reduce((map,r)=>{
      const key=r.project_id+'|'+r.party_id+'|'+r.kind
      const old=map.get(key)||{project:r.project_id,party:r.party,kind:r.kind,totals:Array<bigint>(6).fill(0n)}
      const values=[r.base,r.gst,r.pst,r.gross,r.settled,r.outstanding]
      values.forEach((v,i)=>old.totals[i]+=BigInt(v));map.set(key,old);return map
    },new Map<string,{project:string;party:string;kind:string;totals:bigint[]}>()).values()).map(p=>[names.get(p.project)||p.project,currencies.get(p.project)||'',p.party,p.kind,...p.totals.map(csvMoney)])],
    allocations:[['Project','Currency','Allocation ID','Effective date','Payment ID','Record ID','Party','Record description','Amount'],...allocationRows.map(a=>[names.get(a.project_id)||a.project_id,currencies.get(a.project_id)||'',a.id,a.effective_date,a.payment_id,a.record_id,a.party,a.description,csvMoney(a.amount)])],
    taxes:[['Project','Currency','Filtered material','Filtered labor','Filtered subcontractor','Filtered janitorial','Filtered delivery','Filtered other','Input GST','Input PST','Confirmed recoverable GST','Confirmed recoverable PST','Confirmed non-recoverable GST','Confirmed non-recoverable PST','Pending GST','Pending PST','Review status'],...summaries.map(p=>{
      const t=projectCostTotals(records.filter(r=>r.project_id===p.id))
      return [p.code,p.currency,...[t.material,t.labor,t.subcontractor,t.janitorial,t.delivery,t.other,t.gst,t.pst,t.recoverGST,t.recoverPST,t.nonrecoverGST,t.nonrecoverPST,t.pendingGST,t.pendingPST].map(csvMoney),t.pendingGST+t.pendingPST>0n?'Pending':'Confirmed / not applicable']
    })],
  }
  for(const [key,idKey] of [['summary','project_id'],['records','record_id'],['payments','payment_id']] as const) {
    tables[key][0].push('Attachment count')
    const items=key==='summary'?summaries:key==='records'?records:payments
    items.forEach((item,i)=>tables[key][i+1].push(attachmentCount(idKey,item.id)))
  }
  if(format==='xlsx') {
    const workbook=new ExcelJS.Workbook();workbook.creator='Banyan'
    for(const [name,rows] of Object.entries({Scope:metadata,...tables})) {
      const sheet=workbook.addWorksheet(name)
      rows.forEach(row=>sheet.addRow(row))
      sheet.views=[{state:'frozen',ySplit:1}]
      sheet.getRow(1).font={bold:true}
      sheet.columns.forEach((col,i)=>{col.width=i<4?24:20})
      if(name!=='Scope') sheet.autoFilter={from:{row:1,column:1},to:{row:1,column:rows[0].length}}
    }
    return Buffer.from(await workbook.xlsx.writeBuffer())
  }
  if(!(kind in tables)) throw new Error('Unknown Project export.')
  return csvFile([...metadata,[],...tables[kind]])
}
