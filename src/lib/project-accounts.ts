import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { actingAs, type Runner, type Tx } from './acting'
import type { ProjectCategory } from './project-accounting'
import { projectTaxErrors, type ProjectTaxBindings, type ProjectTaxRole } from './project-tax'

export class ProjectAccountsError extends Error {
  readonly code = 'ACCOUNT_SETUP'
  constructor(message:string) { super(message); this.name='ProjectAccountsError' }
}

export async function ensureProjectAccountsCore(tx:Tx,entityId:string,actor:string) {
  try { await tx.execute(sql`SELECT ensure_project_category_accounts(${entityId}::uuid,${actor})`) }
  catch(error) {
    let current:unknown=error
    for(let i=0;i<6&&current;i++) {
      const message=current instanceof Error?current.message:''
      const prefix='PROJECT_ACCOUNT_SETUP: '
      if(message.startsWith(prefix))throw new ProjectAccountsError(message.slice(prefix.length))
      current=(current as {cause?:unknown}).cause
    }
    throw error
  }
}
export const ensureProjectAccounts=(entityId:string,actor:string,on:Runner=db)=>
  actingAs(actor,tx=>ensureProjectAccountsCore(tx,entityId,actor),on)

/** Reading a page does not create accounts. Initialization belongs to writes. */
export async function projectCategoryAccounts(entityId:string,on:Runner=db) {
  const rows=await on.execute<{category:ProjectCategory;id:string;label:string}>(sql`
    SELECT m.category,a.id::text,a.code||' — '||a.name AS label
    FROM project_category_account m JOIN account a ON a.id=m.account_id AND a.entity_id=m.entity_id
    WHERE m.entity_id=${entityId}::uuid AND a.is_active AND a.is_postable`)
  return Object.fromEntries(rows.map(r=>[r.category,{id:r.id,label:r.label}])) as Partial<Record<ProjectCategory,{id:string;label:string}>>
}

export class ProjectTaxAccountsError extends Error {
  readonly code='TAX_ACCOUNT'
  constructor(message:string) { super(message); this.name='ProjectTaxAccountsError' }
}
/** Tax roles are the company's existing backend binding, also used by its tax
 * registration setup. A unique role wins; the established GIFI account is the
 * default when there are multiple. Never silently choose an arbitrary row. */
export async function projectTaxAccounts(entityId:string,on:Runner=db,prior?:{kind:'revenue'|'cost';gstAccountId?:string|null;pstAccountId?:string|null}):Promise<ProjectTaxBindings> {
  const rows=await on.execute<{id:string;code:string;label:string;role:ProjectTaxRole}>(sql`
    SELECT a.id::text,a.code,a.code||' — '||a.name AS label,ar.role FROM account a
    JOIN account_role ar ON ar.account_id=a.id
    WHERE a.entity_id=${entityId}::uuid AND a.is_active AND a.is_postable AND cardinality(a.required_dimensions)=0
      AND ar.role IN ('gst_hst_payable','gst_hst_recoverable','qst_pst_payable','qst_pst_recoverable')
      AND a.normal_balance::text=CASE WHEN ar.role IN ('gst_hst_payable','qst_pst_payable') THEN 'credit' ELSE 'debit' END
      AND a.account_type::text=CASE WHEN ar.role IN ('gst_hst_payable','qst_pst_payable') THEN 'liability' ELSE 'asset' END
    ORDER BY a.code`)
  const result:ProjectTaxBindings={accounts:{},errors:{}}
  const codes:Record<ProjectTaxRole,string>={gst_hst_payable:'2680',gst_hst_recoverable:'1066',qst_pst_payable:'2681',qst_pst_recoverable:'1483'}
  for(const role of Object.keys(codes) as ProjectTaxRole[]) {
    const candidates=rows.filter(a=>a.role===role)
    const priorId=prior&&(role===(prior.kind==='revenue'?'gst_hst_payable':'gst_hst_recoverable')?prior.gstAccountId:
      role===(prior.kind==='revenue'?'qst_pst_payable':'qst_pst_recoverable')?prior.pstAccountId:undefined)
    const chosen=candidates.find(a=>a.id===priorId)||(candidates.length===1?candidates[0]:candidates.find(a=>a.code===codes[role]))
    if(chosen)result.accounts[role]={id:chosen.id,label:chosen.label}
    else if(candidates.length>1)result.errors[role]=`This company has more than one ${role.startsWith('gst')?'GST/HST':'PST/QST'} ${role.endsWith('payable')?'payable':'recoverable'} account. Review the tax account roles in Accounts; no automatic default could be identified.`
  }
  return result
}
export function resolveProjectTaxAccounts(bindings:ProjectTaxBindings,kind:'revenue'|'cost',lines:Parameters<typeof projectTaxErrors>[2]) {
  const error=projectTaxErrors(bindings,kind,lines)[0]
  if(error)throw new ProjectTaxAccountsError(error)
  return {gstAccountId:bindings.accounts[kind==='revenue'?'gst_hst_payable':'gst_hst_recoverable']?.id,
    pstAccountId:bindings.accounts[kind==='revenue'?'qst_pst_payable':'qst_pst_recoverable']?.id}
}
