import {guardRoute} from '@/lib/gate'
import {productionReport} from '@/lib/production-report'
import {ledgerHead} from '@/lib/ledger-head'
import {csvFile,csvMoney,filename} from '@/lib/csv'
import {quantityInput} from '@/lib/quantity'
import {PRODUCTION_EVENT_LABELS} from '@/lib/production-types'
import {localToday} from '@/lib/today'
export async function GET(request:Request,{params}:{params:Promise<{ledgerId:string}>}) {
 const {ledgerId}=await params,who=await guardRoute();if(who instanceof Response)return who
 const q=new URL(request.url).searchParams,to=q.get('to')??localToday(),from=q.get('from')??to.slice(0,7)+'-01'
 try{
  const [head,events]=await Promise.all([ledgerHead(ledgerId),productionReport(ledgerId,from,to)]);if(!head)return new Response('Company unavailable.',{status:404})
  const csv=csvFile([['Date','Order','Order ID','Output','Warehouse','Action','Item','Quantity','Unit',`Recorded cost (${head.currency})`,`WIP change (${head.currency})`,'Employee','Work date','Production hours','Pay date','Payroll run ID','Payroll journal ID','Pay stub ID','Production time ID','Labour period ID','Settlement ID',`Estimated labour (${head.currency})`,`Actual labour (${head.currency})`,'Event ID','Movement ID','Journal ID','Journal number','No journal reason','Note','Recorded by'],...events.map(e=>[e.event_date,e.order_no,e.order_id,e.output_name,e.warehouse,PRODUCTION_EVENT_LABELS[e.kind],e.sku,quantityInput(e.quantity),e.unit,csvMoney(e.cost),csvMoney(e.wip_change),e.employee_name,e.work_date,e.hours?csvMoney(e.hours):'',e.pay_date,e.pay_run_id,e.payroll_entry_id,e.pay_stub_id,e.time_id,e.labour_period_id,e.settlement_id,e.estimated_labour===null?'':csvMoney(e.estimated_labour),e.actual_labour===null?'':csvMoney(e.actual_labour),e.id,e.movement_id,e.entry_id,e.entry_no,e.no_entry_reason,e.note,e.created_by])])
  return new Response(csv,{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="${filename([head.entity,'production',from,to])}"`,'Cache-Control':'private, no-store'}})
 }catch{return new Response('Choose valid report dates and an available ledger.',{status:400})}
}
