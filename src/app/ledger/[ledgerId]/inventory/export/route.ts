import { guardRoute } from '@/lib/gate'
import { inventoryItems } from '@/lib/inventory'
import { csvFile,csvMoney,filename } from '@/lib/csv'
import { quantityInput } from '@/lib/quantity'
import { ledgerHead } from '@/lib/ledger-head'
export async function GET(_request:Request,{params}:{params:Promise<{ledgerId:string}>}) {
  const {ledgerId}=await params,who=await guardRoute();if(who instanceof Response)return who
  const [items,head]=await Promise.all([inventoryItems(ledgerId),ledgerHead(ledgerId)]);if(!head)return new Response('Company unavailable.',{status:404})
  const csv=csvFile([['SKU','Name','Type','Unit','On hand','Reorder level',`Stock value (${head.currency})`,'Track batches','Track serials','Status','Notes'],...items.map(i=>[i.sku,i.name,i.kind,i.unit,quantityInput(i.on_hand),quantityInput(i.reorder_level),csvMoney(i.fifo_cost),i.track_batches?'Yes':'No',i.track_serials?'Yes':'No',i.is_active?'Active':'Archived',i.notes])])
  return new Response(csv,{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="${filename([head.entity,'inventory'])}"`,'Cache-Control':'private, no-store'}})
}
