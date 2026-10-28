import { DateInput } from '@/components/DateInput'
import { Picker } from '@/components/Picker'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { requireAutomationLedger } from '@/lib/automation-gate'
import { BusinessWorkspace as AutomationShell } from '@/components/BusinessWorkspace'
import { AutomationForm as ActionForm } from '@/components/AutomationForm'
import { automationAction } from '@/app/automation-actions'
import { companyClock,validId } from '@/lib/automation-access'
import { mailColumns,type MailMessage } from '@/lib/mail'
import { BUTTON,FIELD,LABEL } from '@/lib/ui'
import Link from 'next/link'
import {customerEmailPath,serviceSettingsPath} from '@/lib/workflow-links'
export const dynamic='force-dynamic'
export default async function NewMail({params,searchParams}:{params:Promise<{ledgerId:string}>;searchParams:Promise<{invoice?:string;party?:string;parent?:string}>}) {
  const {ledgerId}=await params;await requireAutomationLedger(ledgerId,['/invoices'])
  const query=await searchParams
  const [parent]=query.parent&&validId(query.parent)?await db.execute<MailMessage>(sql`SELECT ${mailColumns} FROM email_message WHERE id=${query.parent}::uuid AND ledger_id=${ledgerId}::uuid`):[]
  const invoiceId=parent?.invoice_id??(query.invoice&&validId(query.invoice)?query.invoice:undefined)
  const invoices=await db.execute<{id:string;label:string;party_id:string}>(sql`SELECT i.id::text,coalesce(i.number,'Unnumbered')||' · '||p.name AS label,i.party_id::text FROM invoice i JOIN party p ON p.id=i.party_id WHERE i.ledger_id=${ledgerId}::uuid AND i.direction='sales' AND i.status='posted' AND i.document_kind IN ('invoice','credit_note') ORDER BY i.issued_on DESC LIMIT 500`)
  const [selected]=invoiceId?await db.execute<{id:string;label:string;party_id:string}>(sql`SELECT i.id::text,coalesce(i.number,'Unnumbered')||' · '||p.name AS label,i.party_id::text FROM invoice i JOIN party p ON p.id=i.party_id WHERE i.id=${invoiceId}::uuid AND i.ledger_id=${ledgerId}::uuid AND i.direction='sales' AND i.status='posted' AND i.document_kind IN ('invoice','credit_note')`):[]
  const partyId=selected?.party_id??parent?.party_id??query.party??''
  const parties=await db.execute<{id:string;label:string;email:string|null}>(sql`SELECT DISTINCT p.id::text,p.name AS label,c.email FROM party p JOIN party_role r ON r.party_id=p.id JOIN ledger l ON l.entity_id=r.entity_id LEFT JOIN party_contact c ON c.party_id=p.id AND c.is_primary WHERE l.id=${ledgerId}::uuid AND r.role='customer' AND p.is_active ORDER BY label`)
  const [invoiceContact]=selected?await db.execute<{email:string|null}>(sql`SELECT email FROM party_contact WHERE party_id=${selected.party_id}::uuid AND is_primary`):[]
  const contact=selected?invoiceContact:parties.find(p=>p.id===partyId)
  const [clock]=await db.execute<{timezone:string}>(sql`SELECT coalesce(s.timezone,'America/Vancouver') AS timezone FROM ledger l LEFT JOIN automation_setting s ON s.entity_id=l.entity_id WHERE l.id=${ledgerId}::uuid`)
  const today=companyClock(clock.timezone).date
  return <AutomationShell context="Income" ledgerId={ledgerId} title="Prepare customer email">
    <p className="mb-5 text-sm text-ink-muted">Prepare a fixed PDF and message first. Review the preview, then explicitly authorize its send.</p>
    {(query.invoice||invoiceId)&&!selected?<p role="alert">Only a posted sales invoice or credit note in this company can be emailed. <Link className="underline" href={`/ledger/${ledgerId}/income`}>Return to Income</Link></p>:selected&&!contact?.email?.trim()?<p role="alert">Add a primary customer email before previewing or sending this invoice. <Link className="underline" href={customerEmailPath(ledgerId,partyId)}>Add customer email</Link></p>:<ActionForm action={automationAction}><input type="hidden" name="ledgerId" value={ledgerId}/><input type="hidden" name="command" value="preview"/><input type="hidden" name="requestKey" value={randomUUID()}/>{parent&&<input type="hidden" name="parentId" value={parent.id}/>}
      <div className="grid max-w-4xl gap-4 sm:grid-cols-2">
        {selected?<><input type="hidden" name="kind" value="invoice"/><input type="hidden" name="partyId" value={selected.party_id}/><input type="hidden" name="invoiceId" value={selected.id}/><p className="text-sm sm:col-span-2">{selected.label}</p></>:<>
          <label className={LABEL}>Document<select name="kind" className={`${FIELD} w-full`} defaultValue={parent?.kind==='reminder'?'open_statement':parent?.kind??'open_statement'}><option value="invoice">Formal invoice</option><option value="open_statement">Open-item statement as of date</option><option value="activity_statement">Period activity statement</option></select></label>
          <label className={LABEL}>Customer<Picker name="partyId" options={parties.map(p=>({id:p.id,label:p.label+(p.email?' · '+p.email:' · no primary email')}))} defaultValue={partyId} ariaLabel="Customer" placeholder="Choose customer" required/></label>
          <label className={`${LABEL} sm:col-span-2`}>Formal invoice (invoice email only)<Picker name="invoiceId" options={invoices} ariaLabel="Formal invoice" placeholder="Choose posted invoice"/></label></>}
        <label className={LABEL}>As of / period end<DateInput name="asOf" className={`${FIELD} w-full`} defaultValue={today} required/></label>
        <label className={LABEL}>Period start (activity statement only)<DateInput name="periodFrom" className={`${FIELD} w-full`} defaultValue={today.slice(0,8)+'01'}/></label>
        <label className={LABEL}>To<input name="to" className={`${FIELD} w-full`} defaultValue={contact?.email??''} readOnly={!!selected} required placeholder="customer@example.com"/>{selected&&<Link className="mt-1 text-metadata underline" href={customerEmailPath(ledgerId,partyId)}>Edit customer email in Parties</Link>}</label>
        <label className={LABEL}>Cc<input name="cc" className={`${FIELD} w-full`} placeholder="Optional; comma-separated"/></label>
        <label className={`${LABEL} sm:col-span-2`}>Subject<input name="subject" className={`${FIELD} w-full`} defaultValue={parent?.subject??(selected?'Invoice — '+selected.label:'Statement of account')} required maxLength={200}/></label>
        <label className={`${LABEL} sm:col-span-2`}>Message<textarea name="body" className={`${FIELD} w-full`} rows={5} defaultValue={parent?.body??'Please review the attached document. Contact us if you have any questions about the amount shown.'} required maxLength={10000}/></label>
        {parent&&<label className={`${LABEL} sm:col-span-2`}>Provider check and reason to authorize a new send<textarea name="resendReason" className={`${FIELD} w-full`} rows={2} required/></label>}
      </div><button className={`${BUTTON} mt-5`}>Preview email</button>
    </ActionForm>}
    <p className="mt-4 text-metadata text-ink-muted"><Link className="underline" href={serviceSettingsPath(ledgerId,'email')}>Email service settings</Link></p>
  </AutomationShell>
}
