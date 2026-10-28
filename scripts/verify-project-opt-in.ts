/** Owns a temporary local database; verifies the actual 116 -> 117 upgrade. */
import './dotenv'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import postgres from 'postgres'

let checks=0
const check=(v:unknown,label:string)=>{assert(v,label);console.log(`PASS PO${++checks} ${label}`)}
async function main() {
  const test=new URL(process.env.TEST_DATABASE_URL!), app=new URL(process.env.DATABASE_URL!)
  assert(test.pathname.endsWith('_test') && ['localhost','127.0.0.1','[::1]'].includes(test.hostname))
  assert(test.host!==app.host || test.pathname!==app.pathname)
  const name=`figtree_project_opt_in_${process.pid}_test`
  const owned=new URL(test);owned.pathname='/'+name
  const adminUrl=new URL(test);adminUrl.pathname='/postgres'
  const admin=postgres(adminUrl.href,{max:1})
  const papers=mkdtempSync(join(tmpdir(),'figtree-project-opt-in-'))
  let connection:ReturnType<typeof postgres>|undefined,created=false
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);created=true
    process.env.DATABASE_URL=owned.href
    process.env.TEST_DATABASE_URL=owned.href
    process.env.ATTACHMENTS_DIR=join(papers,'accounting')
    process.env.PROJECT_ATTACHMENTS_DIR=join(papers,'projects')
    const {db,sql}=await import('../src/db/client');connection=sql
    const {sql:q}=await import('drizzle-orm')
    const [{createFirstOwner,createUser},{createCompanyWithYear,createCompanyReady,coreChartRows},accounts,projectAccounts,modules,access,{MODULE_PATHS},{createProject},{actingAs},{createParty}]=await Promise.all([
      import('../src/lib/users'),import('../src/lib/setup'),import('../src/lib/accounts'),import('../src/lib/project-accounts'),
      import('../src/lib/company-modules'),import('../src/lib/access'),import('../src/lib/nav'),import('../src/lib/project'),
      import('../src/lib/acting'),import('../src/lib/parties')])
    const dir=join(process.cwd(),'db/migrations')
    // This suite intentionally runs a genuine 116 -> 117 cutover first.
    // Read that historical schema directly, then use today's protected reader
    // only after applying today's remaining append-only migrations.
    let current=false
    const chart=async(entityId:string)=>current?accounts.chartOfAccounts(entityId):db.execute<{id:string;code:string;name:string;parent_code:string|null}>(q`SELECT a.id::text,a.code,a.name,p.code AS parent_code FROM account a LEFT JOIN account p ON p.id=a.parent_id WHERE a.entity_id=${entityId}::uuid`)
    const old=readdirSync(dir).filter(f=>f.endsWith('.sql')&&f<'0117').sort()
    assert(old.length===116)
    await sql`CREATE TABLE _migration(filename text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`
    for(const file of old){const body=readFileSync(join(dir,file),'utf8');await sql.begin(async tx=>{
      await tx.unsafe(body);await tx`INSERT INTO _migration(filename,checksum) VALUES(${file},${createHash('sha256').update(body).digest('hex').slice(0,16)})`
    })}
    const me=await createFirstOwner({email:'opt-in@example.test',firstName:'Opt-in tester',password:'Only-Local-Test-123!'})
    const make=(code:string)=>createCompanyWithYear({code,name:`Opt-in ${code} Test`},me.email)
    const provision=async(id:string)=>{
      await actingAs('system:project-account-setup',tx=>tx.execute(q`SELECT ensure_project_category_accounts_v115(${id}::uuid,'system:project-account-setup')`))
      await projectAccounts.ensureProjectAccounts(id,'system:project-cost-sales-group')
    }
    const unused=await make('POUNUSED');await provision(unused.company.id)
    check((await chart(unused.company.id)).length===7,'116 reproduces unwanted accounts on a company without activation')
    const opted=await make('POOPTED');await provision(opted.company.id)
    await db.execute(q`INSERT INTO company_module_access(entity_id,module,enabled,updated_by) VALUES(${opted.company.id}::uuid,'/projects',true,${me.email})`)
    const legacy=await make('POLEGACY');await provision(legacy.company.id)
    const disabled=await make('PODISABLED');await provision(disabled.company.id)
    const customer=await createParty({kind:'organisation',name:'Opt-in customer',actor:me.email,
      roles:[legacy,disabled].map(c=>({entityId:c.company.id,role:'customer' as const,heldFrom:c.year.startDate}))})
    await createProject({entityId:legacy.company.id,currency:'CAD',code:'EXISTING',name:'Existing project',customerPartyId:customer.id,actor:me.email})
    await createProject({entityId:disabled.company.id,currency:'CAD',code:'HISTORY',name:'Disabled project history',customerPartyId:customer.id,actor:me.email})
    await db.execute(q`INSERT INTO company_module_access(entity_id,module,enabled,updated_by) VALUES(${disabled.company.id}::uuid,'/projects',false,${me.email})`)
    // Historical fixture writes use its own schema, rather than today's ORM columns.
    const seedAccounts=async(entityId:string,rows:Parameters<typeof accounts.importAccounts>[1],actor:string)=>actingAs(actor,async tx=>{
      const result:Array<{id:string}>=[]
      for(const row of rows){
        const [saved]=await tx.execute<{id:string}>(q`INSERT INTO account(entity_id,code,name,account_type,normal_balance)
          VALUES(${entityId}::uuid,${row.code},${row.name},${row.accountType}::account_type,${['asset','expense'].includes(row.accountType)?'debit':'credit'}::normal_balance) RETURNING id::text`)
        for(const role of row.roles??[])await tx.execute(q`INSERT INTO account_role(account_id,role) VALUES(${saved.id}::uuid,${role})`)
        result.push(saved)
      }
      return result
    })
    const used=await make('POUSED');await provision(used.company.id)
    const [cash]=await seedAccounts(used.company.id,[{entityId:used.company.id,code:'1000',name:'Bank',accountType:'asset',roles:['cash_and_cash_equivalents']}],me.email)
    const usedMap=await projectAccounts.projectCategoryAccounts(used.company.id)
    await actingAs(me.email,async tx=>{
      const [period]=await tx.execute<{id:string}>(q`SELECT id::text FROM fiscal_period WHERE ledger_id=${used.ledger.id}::uuid AND ${used.year.startDate}::date BETWEEN start_date AND end_date`)
      const [entry]=await tx.execute<{id:string}>(q`INSERT INTO journal_entry(ledger_id,entry_no,entry_date,period_id,description,status,total_debit,total_credit,posted_at,posted_by)
        VALUES(${used.ledger.id}::uuid,'JE-PO-00001',${used.year.startDate}::date,${period.id}::uuid,'Real account use','posted',10000,10000,now(),${me.email}) RETURNING id::text`)
      await tx.execute(q`INSERT INTO journal_line(entry_id,line_no,account_id,amount) VALUES(${entry.id}::uuid,1,${usedMap.material!.id}::uuid,10000),(${entry.id}::uuid,2,${cash.id}::uuid,-10000)`)
      await tx.execute(q`SELECT rebuild_period_balances(${used.ledger.id}::uuid)`)
    })
    // Also preserve an unused account referenced only by a zero balance cache.
    const [period]=await db.execute<{id:string}>(q`SELECT id::text FROM fiscal_period WHERE ledger_id=${used.ledger.id}::uuid ORDER BY start_date LIMIT 1`)
    await db.execute(q`INSERT INTO period_balance(ledger_id,period_id,account_id) VALUES(${used.ledger.id}::uuid,${period.id}::uuid,${usedMap.labor!.id}::uuid)`)
    const reused=await make('POREUSED')
    await seedAccounts(reused.company.id,[{entityId:reused.company.id,code:'8000',name:'My existing revenue',accountType:'revenue',roles:['revenue_from_contracts']},
      {entityId:reused.company.id,code:'8320',name:'My existing materials',accountType:'expense',roles:['raw_materials_and_consumables']}],me.email)
    await provision(reused.company.id)
    const manualBefore=await db.execute(q`SELECT a.*,ARRAY(SELECT role FROM account_role WHERE account_id=a.id ORDER BY role) AS roles FROM account a WHERE entity_id=${reused.company.id}::uuid AND code IN ('8000','8320') ORDER BY code`)
    const edited=await make('POEDITED');await provision(edited.company.id)
    await actingAs(me.email,tx=>tx.execute(q`UPDATE account SET name='My renamed delivery' WHERE entity_id=${edited.company.id}::uuid AND code='8457'`))
    const financial=async()=>JSON.stringify(await db.execute(q`SELECT
      (SELECT jsonb_agg(to_jsonb(j) ORDER BY id) FROM journal_entry j) AS entries,
      (SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM journal_line l) AS lines,
      (SELECT jsonb_agg(to_jsonb(b) ORDER BY ledger_id,period_id,account_id) FROM period_balance b) AS balances`))
    const before=await financial()
    const file='0117_project_opt_in.sql',body=readFileSync(join(dir,file),'utf8')
    await sql.begin(async tx=>{await tx.unsafe(body);await tx`INSERT INTO _migration(filename,checksum) VALUES(${file},${createHash('sha256').update(body).digest('hex').slice(0,16)})`})
    check((await chart(unused.company.id)).length===0 && Object.keys(await projectAccounts.projectCategoryAccounts(unused.company.id)).length===0,'117 removes only upgrade-created unused accounts and their mappings')
    check((await modules.companyModulePolicies())[opted.company.id].includes('/projects') && (await chart(opted.company.id)).length===7,'explicit opt-in preserves accounts even before the first project')
    check((await modules.companyModulePolicies())[legacy.company.id].includes('/projects') && (await chart(legacy.company.id)).length===7,'existing Project data preserves legacy access and accounts')
    check(!(await modules.companyModulePolicies())[disabled.company.id].includes('/projects') && (await chart(disabled.company.id)).length===7,'explicit disablement and historical Project accounts are both preserved')
    check(before===await financial(),'all posted journal rows and balance rows remain identical')
    const held=await chart(used.company.id)
    check(held.some(a=>a.id===usedMap.material!.id)&&held.some(a=>a.id===usedMap.labor!.id)&&held.some(a=>a.code==='8518'),'posted use, zero balance references and their parent remain')
    const manualAfter=await db.execute(q`SELECT a.*,ARRAY(SELECT role FROM account_role WHERE account_id=a.id ORDER BY role) AS roles FROM account a WHERE entity_id=${reused.company.id}::uuid AND code IN ('8000','8320') ORDER BY code`)
    check(JSON.stringify(manualBefore)===JSON.stringify(manualAfter),'reused hand-created accounts keep their IDs, fields, roles and parent')
    check((await chart(edited.company.id)).some(a=>a.code==='8457'&&a.name==='My renamed delivery'),'a human-modified upgrade account survives')
    for(const file of readdirSync(dir).filter(f=>f.endsWith('.sql')&&f>'0117_project_opt_in.sql').sort()){
      const body=readFileSync(join(dir,file),'utf8');await sql.begin(async tx=>{await tx.unsafe(body);await tx`INSERT INTO _migration(filename,checksum) VALUES(${file},${createHash('sha256').update(body).digest('hex').slice(0,16)})`})
    }
    current=true
    const fresh=await createCompanyReady({code:'POFRESH',name:'Fresh Non-project Company Test'},me.email)
    const operationsCodes=await db.execute<{code:string}>(q`SELECT code FROM operations_account_specs('/assets') UNION SELECT code FROM operations_account_specs('/inventory')`)
    const expectedCodes=[...new Set([...coreChartRows().map(a=>a.code),...operationsCodes.map(a=>a.code)])].sort()
    check(JSON.stringify((await accounts.chartOfAccounts(fresh.company.id)).map(a=>a.code).sort())===JSON.stringify(expectedCodes) && Object.keys(await projectAccounts.projectCategoryAccounts(fresh.company.id)).length===0,'new company prepares core and operations accounts without Project bindings')
    check(!(await modules.companyModulePolicies())[fresh.company.id].includes('/projects') && (await access.refuseForLedger(me,fresh.ledger.id,'/projects'))?.code==='NO_MODULE','missing switch is disabled in company settings and owner route access')
    try{await projectAccounts.ensureProjectAccounts(fresh.company.id,me.email);throw Error('Unexpected initialization')}catch(e){check(e instanceof projectAccounts.ProjectAccountsError,'initializer refuses a missing explicit Project activation')}
    const person=await createUser({email:'project-only@example.test',firstName:'Project only',password:'Only-Local-Test-123!',actor:me.email})
    await access.setGrants({userId:person.id,entityIds:[fresh.company.id],modules:['/projects'],actor:me.email})
    check((await db.execute(q`SELECT id FROM entity e WHERE ${access.mayOpenEntity(person,q`e.id`)}`)).length===0,'a user grant alone cannot enable Project or expose its company')
    await modules.setCompanyModules(me,{entityId:fresh.company.id,modules:MODULE_PATHS})
    const activated=await projectAccounts.projectCategoryAccounts(fresh.company.id)
    check(Object.keys(activated).length===7 && (await accounts.chartOfAccounts(fresh.company.id)).filter(a=>a.parent_code==='8518').length===5,'explicit company activation creates defaults with five cost children')
    check((await access.refuseForLedger(person,fresh.ledger.id,'/projects'))===null && (await db.execute(q`SELECT id FROM entity e WHERE ${access.mayOpenEntity(person,q`e.id`)}`)).length===1,'explicit activation exposes Project to the already granted user')
    const ids=JSON.stringify(activated)
    await modules.setCompanyModules(me,{entityId:fresh.company.id,modules:MODULE_PATHS.filter(m=>m!=='/projects')})
    check(JSON.stringify(await projectAccounts.projectCategoryAccounts(fresh.company.id))===ids,'later module disablement does not delete deliberately provisioned accounts')
    console.log(`Project opt-in checks passed: ${checks}\n=== ALL CHECKS PASSED ===`)
  } finally {
    if(connection)await connection.end()
    if(created)await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`)
    await admin.end();rmSync(papers,{recursive:true,force:true})
  }
}
main().catch(e=>{console.error(e);process.exitCode=1})
