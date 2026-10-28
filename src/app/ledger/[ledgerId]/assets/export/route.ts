import { guardRoute } from '@/lib/gate'
import {depreciationAssets} from '@/lib/depreciation'
import { assetRows } from '@/lib/assets'
import { csvFile,csvMoney,filename } from '@/lib/csv'
import { ledgerHead } from '@/lib/ledger-head'
export async function GET(_request:Request,{params}:{params:Promise<{ledgerId:string}>}) {
  const {ledgerId}=await params,who=await guardRoute();if(who instanceof Response)return who
  const [rows,head,book]=await Promise.all([assetRows(ledgerId),ledgerHead(ledgerId),depreciationAssets(ledgerId)]);if(!head)return new Response('Company unavailable.',{status:404})
  const csv=csvFile([['Code','Name','Category','Acquired on','In service on',`Acquisition cost (${head.currency})`,'Supplier','Serial number','Location','Custodian','Status','Warranty until','Disposed on',`Disposal proceeds (${head.currency})`,'Notes',`Accumulated depreciation (${head.currency})`,`Net book value (${head.currency})`],...rows.map(a=>[a.code,a.name,a.category,a.acquired_on,a.in_service_on,csvMoney(a.acquisition_cost),a.supplier,a.serial_number,a.location,a.custodian,a.status,a.warranty_until,a.disposed_on,csvMoney(a.disposal_proceeds),a.notes,csvMoney(book.find(x=>x.id===a.id)?.accumulated??'0'),csvMoney(book.find(x=>x.id===a.id)?.net_book_value??a.acquisition_cost)])])
  return new Response(csv,{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="${filename([head.entity,'fixed-assets'])}"`,'Cache-Control':'private, no-store'}})
}
