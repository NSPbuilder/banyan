import {requireLedger} from '@/lib/gate'
import {OperationsFinanceView} from '@/components/OperationsFinance'
import {localToday} from '@/lib/today'
import {operationDate} from '@/lib/operations-scope'
import {initializeFinanceAction,connectFinanceAction,financeSettingsAction} from './actions'
export const dynamic='force-dynamic'
export default async function FinancePage({params,searchParams}:{params:Promise<{ledgerId:string}>;searchParams:Promise<{date?:string}>}) {
 const {ledgerId}=await params;await requireLedger(ledgerId,'/inventory');const q=await searchParams;let date=localToday();try{if(q.date)date=operationDate(q.date)}catch{}
 return <OperationsFinanceView ledgerId={ledgerId} seat="/inventory" date={date} initialize={initializeFinanceAction} connect={connectFinanceAction} save={financeSettingsAction}/>
}
