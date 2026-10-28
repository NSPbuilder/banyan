import { createCompany,createFiscalYear } from '../src/lib/setup'
import { importAccounts,parseAccountsCsv } from '../src/lib/accounts'
import { createParty } from '../src/lib/parties'
import { createInvoice,postInvoice } from '../src/lib/invoices'

export const P5_CHART='1000,Bank,asset,,cash_and_cash_equivalents\n1100,Stripe clearing,asset,,other_receivables\n1200,Receivables,asset,,trade_receivables\n3000,Equity,equity,,retained_earnings\n4000,Revenue,revenue,,revenue_from_contracts\n5000,Payment processing fees,expense,,other_operating_expenses'
export async function p5Company(prefix:string,email:string) {
  const co=await createCompany({code:prefix,name:prefix+' isolated P5 company'},email)
  await createFiscalYear(co.ledger.id,'2026-12-31',email)
  const accounts=await importAccounts(co.company.id,parseAccountsCsv(P5_CHART).map(a=>({...a,entityId:co.company.id})),email)
  const at=(code:string)=>accounts.find(a=>a.code===code)!.id
  const customer=await createParty({kind:'organisation',name:prefix+' customer',roles:[{entityId:co.company.id,role:'customer',heldFrom:'2026-01-01'}],actor:email})
  const otherCustomer=await createParty({kind:'organisation',name:prefix+' other customer',roles:[{entityId:co.company.id,role:'customer',heldFrom:'2026-01-01'}],actor:email})
  const invoice=async(number:string,amount=100000n,partyId=customer.id)=>{
    const inv=await createInvoice({ledgerId:co.ledger.id,direction:'sales',partyId,controlAccountId:at('1200'),issuedOn:'2026-10-01',dueOn:'2026-10-31',number,
      lines:[{accountId:at('4000'),amount:-amount,description:'Customer-facing service'}],actor:email})
    await postInvoice(inv.id,email);return inv.id
  }
  return {...co,at,customer,otherCustomer,invoice}
}
