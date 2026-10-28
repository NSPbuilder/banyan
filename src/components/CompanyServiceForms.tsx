import {AutomationForm} from './AutomationForm'
import {companyServiceAction} from '@/app/settings/service-actions'
import {automationAction} from '@/app/automation-actions'
import type {CompanyServices} from '@/lib/company-services'
import {BUTTON,FIELD,LABEL} from '@/lib/ui'
export function CompanyServiceForm({ledgerId,setting,kind,encryptionReady}:{ledgerId:string;setting:CompanyServices;kind:'email'|'reminders'|'execution';encryptionReady:boolean}){
  return <AutomationForm action={kind==='execution'?automationAction:companyServiceAction} className="max-w-3xl">
    <input type="hidden" name="ledgerId" value={ledgerId}/><input type="hidden" name="version" value={setting.version}/><input type="hidden" name="command" value={kind==='email'?'smtp':kind==='reminders'?'schedule':'settings'}/>
    <div className="grid gap-4 sm:grid-cols-2">{kind==='email'?<>
      <label className={LABEL}>Sender email<input name="senderEmail" type="email" defaultValue={setting.sender_email??''} className={`${FIELD} w-full`} required/></label>
      <label className={LABEL}>SMTP host<input name="host" defaultValue={setting.smtp_host??''} className={`${FIELD} w-full`} placeholder="smtp.example.com"/></label>
      <label className={LABEL}>Port<input name="port" type="number" min={1} max={65535} defaultValue={setting.smtp_port} className={`${FIELD} w-full`} required/></label>
      <label className={LABEL}>Connection security<select name="secure" defaultValue={String(setting.smtp_secure)} className={`${FIELD} w-full`}><option value="false">STARTTLS (usually 587)</option><option value="true">TLS (usually 465)</option></select></label>
      <label className={LABEL}>Username<input name="username" defaultValue={setting.smtp_username??''} className={`${FIELD} w-full`} autoComplete="off"/></label>
      <label className={LABEL}>Password<input name="password" type="password" className={`${FIELD} w-full`} autoComplete="new-password" placeholder={setting.has_password?'Saved; blank keeps it':'SMTP password'}/></label>
      <label className="sm:col-span-2"><input type="checkbox" name="clear"/> Clear company SMTP and use installation configuration</label>
      {!encryptionReady&&<p className="text-metadata text-ink-muted sm:col-span-2">Configure the installation integration encryption key before saving an SMTP password.</p>}
    </>:kind==='reminders'?<>
      <label className={`${LABEL} sm:col-span-2`}>Overdue days<input name="days" defaultValue={setting.reminder_days.join(',')} className={`${FIELD} w-full`} required/><span className="text-metadata text-ink-muted">Comma-separated, for example 3,7,14. Uses company time zone: {setting.timezone}.</span></label>
      <label className={LABEL}>Local start hour<input name="startHour" type="number" min={0} max={23} defaultValue={setting.reminder_start_hour} className={`${FIELD} w-full`} required/></label>
      <label className={LABEL}>Local end hour<input name="endHour" type="number" min={1} max={24} defaultValue={setting.reminder_end_hour} className={`${FIELD} w-full`} required/></label>
      <p className="text-metadata text-ink-muted sm:col-span-2">Enable reminders for each customer in Parties. Existing custom schedules are retained. Missed historical reminders are not sent as a batch.</p>
    </>:<>
      <label className={LABEL}>Company time zone<input name="timezone" defaultValue={setting.timezone} className={`${FIELD} w-full`} required/></label>
      <input type="hidden" name="senderEmail" value={setting.sender_email??''}/>
      <label className="self-end"><input type="checkbox" name="enabled" defaultChecked={setting.enabled}/> Enable company automation</label>
      <label><input type="checkbox" name="mailEnabled" defaultChecked={setting.mail_enabled}/> Enable company email</label>
      <p className="text-metadata text-ink-muted sm:col-span-2">Installation worker: {process.env.AUTOMATION_ENABLED==='true'?'enabled':'paused'}. Scheduled work also requires a running worker.</p>
    </>}</div><button className={`${BUTTON} mt-5`}>{kind==='email'?'Save email settings':kind==='reminders'?'Save reminder schedule':'Save execution settings'}</button>
  </AutomationForm>
}
