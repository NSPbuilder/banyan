import './env'
import assert from 'node:assert/strict'
import {sql as q} from 'drizzle-orm'
import {db,sql} from '../src/db/client'
import {createFirstOwner} from '../src/lib/users'
import {createCompanyReady} from '../src/lib/setup'
import {exportCompany,restoreCompany} from '../src/lib/backup'
import {companyModulePolicies} from '../src/lib/company-modules'
import {companySetupPlan,savedCompanySetupPlan,CompanySetupError,fiscalEndOn} from '../src/lib/company-onboarding'

async function main(){
 const me=await createFirstOwner({email:'onboarding-suite@example.test',firstName:'Setup owner',password:'Onboarding-suite-123!'})
 const plan=companySetupPlan({start:'csv',focus:['inventory','payroll','projects','inventory'],chart:'standard'})
 const made=await createCompanyReady({code:'ONBOARD',name:'Onboarding source company',province:'BC',fiscalYearEndMonth:6,fiscalYearEndDay:30,onboarding:plan},me.email)
 const [record]=await db.execute<{after:{onboarding:unknown}}>(q`SELECT after FROM audit_log WHERE action='create_company' AND table_name='entity' AND record_id=${made.company.id}`)
 assert.deepEqual(savedCompanySetupPlan(record.after.onboarding),{start:'csv',focus:['inventory','payroll','projects'],chart:'standard'})
 assert.equal(made.ledger.currency,'CAD');assert.equal(made.ledger.accountingStandard,'IFRS');assert.equal(made.periodCount,12)
 assert(!(await companyModulePolicies())[made.company.id].includes('/projects'))
 const [noEntries]=await db.execute<{n:number}>(q`SELECT count(*)::int n FROM journal_entry WHERE ledger_id=${made.ledger.id}::uuid`);assert.equal(noEntries.n,0)
 const [capabilities]=await db.execute<{revenue:boolean;wages:boolean}>(q`SELECT EXISTS(SELECT 1 FROM account a JOIN account_role r ON r.account_id=a.id WHERE a.entity_id=${made.company.id}::uuid AND r.role='revenue_from_contracts') revenue,EXISTS(SELECT 1 FROM account a JOIN account_role r ON r.account_id=a.id WHERE a.entity_id=${made.company.id}::uuid AND r.role='employee_benefits_expense') wages`);assert(capabilities.revenue&&capabilities.wages)
 console.log('PASS ONB01: saved guidance, standard fiscal foundation, no financial entries and no extra module grants')
 const before=(await db.execute<{n:number}>(q`SELECT count(*)::int n FROM entity`))[0].n
 await assert.rejects(()=>createCompanyReady({code:'INVALID',name:'Invalid onboarding plan',onboarding:{start:'outside-url' as never,focus:[]}},me.email),CompanySetupError)
 assert.equal((await db.execute<{n:number}>(q`SELECT count(*)::int n FROM entity`))[0].n,before)
 assert.deepEqual(savedCompanySetupPlan({start:'outside-url',focus:['invented']}),{start:'fresh',focus:['invoices']})
 assert.equal(fiscalEndOn(2,29,'2026-10-12'),'2027-02-28');assert.equal(fiscalEndOn(2,29,'2027-10-12'),'2028-02-29')
 console.log('PASS ONB02: untrusted choices rejected before creation, old metadata fallback and valid leap-year preview')
 const file=await exportCompany(made.company.id),copy=await restoreCompany(file,me.email,{code:'ONBCOPY',name:'Restored onboarding company'})
 const [restored]=await db.execute<{after:{onboarding:unknown}}>(q`SELECT after FROM audit_log WHERE action='create_company' AND table_name='entity' AND record_id=${copy.entityId}`)
 assert(restored);assert.deepEqual(savedCompanySetupPlan(restored.after.onboarding),plan)
 console.log('PASS ONB03: portable audit metadata remaps company identity and preserves initial guide choices')
 console.log('=== ALL CHECKS PASSED ===')
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>sql.end())
