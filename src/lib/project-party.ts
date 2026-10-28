import 'server-only'
import { createPartyFromForm } from './party-forms'
import { projectCompany, ProjectError } from './project'
import { PARTY_FIELDS as F } from './forms'

/** Called behind the /projects action gate. Reuse the existing Party create
 * reader while taking company identity from the ledger, never the client. */
export async function createProjectPartyFromForm(form:FormData,actor:string) {
  const company=await projectCompany(String(form.get('ledgerId')||''))
  if(company.archived_at)throw new ProjectError('ARCHIVED','Company archived · Read-only')
  const role=String(form.get('role')||'')
  if(role!=='customer'&&role!=='supplier')throw new ProjectError('PARTY','Choose customer or supplier.')
  const fields=new FormData()
  for(const key of [F.ledgerId,F.name,F.taxNumber,F.tradingName,F.notes,F.contactName,F.email,F.phone,
    F.line1,F.line2,F.city,F.region,F.postalCode,F.country])fields.set(key,String(form.get(key)||''))
  fields.set('entityId',company.id)
  fields.set('kind',String(form.get('kind')||'organisation'))
  fields.set('role',role)
  return createPartyFromForm(fields,actor)
}
