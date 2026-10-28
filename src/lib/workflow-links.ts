export const incomeEmailPath=(ledgerId:string,id?:string)=>`/ledger/${ledgerId}/income/email${id?'/'+id:''}`
export const inboxPath=(ledgerId:string,id?:string)=>`/ledger/${ledgerId}/readings/inbox${id?'/'+id:''}`
export const serviceSettingsPath=(ledgerId:string,section='email')=>`/settings/services?ledger=${ledgerId}&section=${section}`
export const customerEmailPath=(ledgerId:string,partyId:string)=>`/ledger/${ledgerId}/parties/${partyId}#contact-email`
export function invoiceEmailLink(ledgerId:string,invoiceId:string,partyId:string,email:string|null|undefined,status:string){
  if(status!=='posted')return status==='draft'?'Post before emailing':'—'
  return email?.trim()?{text:'Preview email',href:incomeEmailPath(ledgerId,'new')+'?invoice='+invoiceId}:{text:'Add customer email',href:customerEmailPath(ledgerId,partyId)}
}
