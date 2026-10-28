import {Picker} from './Picker'
import {AutomationForm} from './AutomationForm'
import {EditLease} from './EditLease'
import {integrationAction} from '@/app/integration-actions'
import {BUTTON,QUIET,FIELD,LABEL} from '@/lib/ui'
type Account={id:string;label:string;type:string}
export function IntegrationSettings({ledgerId,kind,connection,accounts=[],canConfigure}:{ledgerId:string;kind:'payment'|'inbound';connection:Record<string,unknown>|null;accounts?:Account[];canConfigure:boolean}){
  const value=(key:string,fallback='')=>String(connection?.[key]??fallback),id=value('id')
  if(!canConfigure)return <p>Only a company administrator can configure this service.</p>
  const select=(name:string,title:string,current:string,type?:string)=><label className={LABEL}>{title}<Picker name={name} ariaLabel={title} defaultValue={current} required={name!=='bankId'} options={accounts.filter(a=>!type||a.type===type)} placeholder="Choose account"/></label>
  return <AutomationForm action={integrationAction} className="max-w-3xl">
    <input type="hidden" name="ledgerId" value={ledgerId}/><input type="hidden" name="id" value={id}/>
    {id&&<EditLease resource={{ledgerId,type:kind,id}} version={value('version')}/>}
    <div className="grid gap-4 sm:grid-cols-2">{kind==='payment'?<>
      <label className={LABEL}>Environment<select className={`${FIELD} w-full`} name="mode" defaultValue={value('mode','test')}><option value="test">Test</option><option value="live">Live</option></select></label>
      <label className={LABEL}>Accounting time zone<input className={`${FIELD} w-full`} name="timezone" defaultValue={value('timezone','America/Vancouver')} required/></label>
      {select('clearingId','Stripe clearing account',value('clearing_account_id'),'asset')}{select('feeId','Processor fee expense',value('fee_account_id'),'expense')}{select('bankId','Payout bank account',value('bank_account_id'),'asset')}
      <label className={LABEL}>Stripe secret key<input className={`${FIELD} w-full`} name="key" type="password" autoComplete="off" placeholder={connection?.has_key?'Saved; blank keeps it':'sk_test_…'}/></label>
      <label className={LABEL}>Endpoint signing secret<input className={`${FIELD} w-full`} name="webhook" type="password" autoComplete="off" placeholder={connection?.has_webhook?'Saved; blank keeps it':'whsec_…'}/></label>
    </>:<>
      <label className={LABEL}>Postmark server identifier<input className={`${FIELD} w-full`} name="providerAccount" defaultValue={value('provider_account')} required/></label>
      <label className={LABEL}>Postmark inbound address<input className={`${FIELD} w-full`} name="recipientBase" type="email" defaultValue={value('recipient_base')} required/></label>
      <label className={LABEL}>Webhook Basic Auth username<input className={`${FIELD} w-full`} name="username" autoComplete="off" placeholder={connection?.has_username?'Saved; blank keeps it':'Random ASCII username'}/></label>
      <label className={LABEL}>Webhook Basic Auth password<input className={`${FIELD} w-full`} name="password" type="password" autoComplete="off" placeholder={connection?.has_password?'Saved; blank keeps it':'Random password, 24+ characters'}/></label>
      {id&&<><label><input type="checkbox" name="rotate"/> Rotate the forwarding alias</label><label><input type="checkbox" name="enabled" defaultChecked={connection?.enabled===true}/> Enable inbound mail</label></>}
    </>}</div>
    <div className="mt-5 flex flex-wrap gap-3"><button className={BUTTON} name="command" value={kind+(id?'-save':'-create')}>{kind==='payment'?'Save disabled configuration':'Save inbound configuration'}</button>
      {kind==='payment'&&id&&<><button className={QUIET} name="command" value="payment-verify">Verify merchant</button><button className={QUIET} name="command" value="payment-enable">Apply payment availability</button><label><input type="radio" name="operation" value="enable"/> Enable</label><label><input type="radio" name="operation" value="disable" defaultChecked/> Disable</label></>}
    </div>
  </AutomationForm>
}
