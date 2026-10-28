'use client'
import {useState} from 'react'
import {BUTTON,QUIET,REFUSAL} from '@/lib/ui'
type Invoice={company:string;number:string|null;status:string;currency:string;issuedOn:string;dueOn:string;amount:string;updated:boolean;paymentReview:boolean}
export function Portal({invitationId}:{invitationId:string}){
  const [invoice,setInvoice]=useState<Invoice|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  const base='/pay/'+invitationId
  async function call(path:string,method='GET',body?:object){
    const response=await fetch(base+path,{method,cache:'no-store',credentials:'same-origin',headers:method==='POST'?{'content-type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined})
    const result=await response.json();if(!response.ok)throw Error(result.error||'The invoice is unavailable. Contact its sender.');return result
  }
  async function act(task:()=>Promise<void>){setBusy(true);setError('');try{await task()}catch(e){setError(e instanceof Error?e.message:'The invoice is unavailable.')}finally{setBusy(false)}}
  async function open(){
    const token=window.location.hash.slice(1)
    if(token){await call('/session','POST',{token});history.replaceState(null,'',window.location.pathname)}
    setInvoice(await call('/status'))
  }
  const cents=invoice?BigInt(invoice.amount):0n,amount=(cents/100n).toString()+'.'+(cents%100n).toString().padStart(2,'0')
  return <div>{error&&<p role="alert" className={`${REFUSAL} mb-4`}>{error}</p>}
    {!invoice?<><p className="mb-5 text-ink-muted">Open this link to view one current invoice and its customer PDF. Contact the sender if your link has expired.</p><button className={BUTTON} disabled={busy} onClick={()=>act(open)}>Open invoice</button></>:<>
      <p className="text-sm text-ink-muted">{invoice.company}</p><h2 className="my-3 text-xl">{invoice.number??'Invoice'}</h2>
      {invoice.updated&&<p className="mb-3">This invoice was updated. Review the current PDF and amount.</p>}
      <p>Issued {invoice.issuedOn} · Due {invoice.dueOn}</p><p className="my-5 text-3xl tabular-nums">{invoice.currency} {amount}</p>
      {invoice.status==='void'?<p>This invoice is void. No payment is requested.</p>:cents===0n?<p>No unpaid amount remains.</p>:null}
      {invoice.paymentReview&&<p className="my-4">A payment, refund or dispute requires review. Contact the sender before paying again.</p>}
      <div className="mt-5 flex flex-wrap gap-3 print:hidden">{invoice.status==='posted'&&<a className={QUIET} href={base+'/pdf'}>Download PDF</a>}
        <button className={QUIET} disabled={busy} onClick={()=>act(async()=>setInvoice(await call('/status')))}>Refresh status</button>
        {invoice.status==='posted'&&cents>0n&&!invoice.paymentReview&&<button className={BUTTON} disabled={busy} onClick={()=>act(async()=>{const {url}=await call('/checkout','POST',{});if(new URL(url).origin!=='https://checkout.stripe.com')throw Error('Invalid payment destination.');window.location.assign(url)})}>Pay by card</button>}
      </div><p className="mt-5 text-sm text-ink-muted">Payment status comes from the payment provider and the invoice sender’s records.</p>
    </>}{busy&&<p role="status" className="mt-4">Please wait…</p>}</div>
}
