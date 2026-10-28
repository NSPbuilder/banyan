import { chromium, expect } from '@playwright/test'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import dotenv from 'dotenv'

async function main() {
  const isolation=JSON.parse(readFileSync('docs/evidence/p3/isolation.json','utf8'))
  if(!isolation.createdNew||isolation.productionTouched||!isolation.environmentPath)throw Error('Invalid P3 isolation proof')
  const config=dotenv.parse(readFileSync(isolation.environmentPath))
  if(new URL(config.DATABASE_URL).pathname.slice(1)!==isolation.applicationDatabase
    || new URL(config.TEST_DATABASE_URL).pathname.slice(1)!==isolation.testDatabase
    || config.TEST_DATABASE_CONFIRMATION!==isolation.testDatabase)throw Error('P3 browser isolation mismatch')
  if(process.argv.includes('--seed-after')) {
    if(process.env.DATABASE_URL!==config.DATABASE_URL)throw Error('Final browser seed must use the confirmed APP database')

 const before=JSON.parse(readFileSync(isolation.browserBaselineFixturePath,'utf8'))
    const {db,sql:connection}=await import('../src/db/client'),{sql}=await import('drizzle-orm')
    try {
      const {signIn}=await import('../src/lib/users'),{createCompany,createFiscalYear}=await import('../src/lib/setup'),{importAccounts,parseAccountsCsv}=await import('../src/lib/accounts'),{createParty}=await import('../src/lib/parties'),{HISTORY_TARGET_ACCOUNTS}=await import('./p3-fixtures')
      await signIn({email:before.email,password:before.password,clientIp:'192.0.2.83'})
      const co=await createCompany({code:'P3UI'+randomBytes(3).toString('hex').toUpperCase(),name:'P3 UI '+randomBytes(3).toString('hex')},before.email)
      await createFiscalYear(co.ledger.id,'2025-09-30',before.email);await createFiscalYear(co.ledger.id,'2026-09-30',before.email)
      const accounts=await importAccounts(co.company.id,parseAccountsCsv(HISTORY_TARGET_ACCOUNTS).map(a=>({...a,entityId:co.company.id})),before.email)
      const cust=await createParty({kind:'organisation',name:co.company.code+' customer',roles:[{entityId:co.company.id,role:'customer',heldFrom:'2025-01-01'}],actor:before.email}),sup=await createParty({kind:'organisation',name:co.company.code+' supplier',roles:[{entityId:co.company.id,role:'supplier',heldFrom:'2025-01-01'}],actor:before.email})
      const [fy]=await db.execute<{id:string}>(sql`SELECT id::text FROM fiscal_year WHERE ledger_id=${co.ledger.id}::uuid AND end_date='2026-09-30'`)
      writeFileSync(process.env.P3_UI_FIXTURE!,JSON.stringify({...before,beforeLedgerId:before.ledgerId,ledgerId:co.ledger.id,accounts,cust:cust.id,sup:sup.id,fiscalYearId:fy.id}),{mode:0o600})
    }finally{await connection.end()}
    return
  }
  if(process.argv.includes('--seed-before')) {
    if(process.env.DATABASE_URL!==config.DATABASE_URL)throw Error('Baseline seed must use the confirmed APP database')
    const {db,sql:connection}=await import('../src/db/client'),{sql}=await import('drizzle-orm')
    try {
      const [state]=await db.execute<{n:number}>(sql`SELECT count(*)::int AS n FROM entity`)
      if(state.n)throw Error('Baseline APP seed requires a new empty isolated database')
      const {createFirstOwner}=await import('../src/lib/users'),{createCompany,createFiscalYear}=await import('../src/lib/setup'),{importAccounts}=await import('../src/lib/accounts')
      const email='p3-browser@example.test',password='P3 isolated '+randomBytes(18).toString('hex')
      const owner=await createFirstOwner({email,firstName:'P3',password})
      const company=await createCompany({code:'P3BASE',name:'P3 baseline workspace'},owner.email)
      await createFiscalYear(company.ledger.id,'2026-09-30',owner.email)
      await importAccounts(company.company.id,[
        {entityId:company.company.id,code:'1000',name:'Cash',accountType:'asset',roles:['cash_and_cash_equivalents']},
        {entityId:company.company.id,code:'4000',name:'Revenue',accountType:'revenue',roles:['revenue_from_contracts']},
        {entityId:company.company.id,code:'5000',name:'Expenses',accountType:'expense',roles:['other_operating_expenses']},
      ],owner.email)
      writeFileSync(process.env.P3_UI_FIXTURE!,JSON.stringify({email,password,ledgerId:company.ledger.id}),{mode:0o600})
    } finally {await connection.end()}
    return
  }
  const beforeMode=process.argv.includes('--before')
  const scratch=mkdtempSync(join(tmpdir(),'figtree-p3-ui-')),fixture=join(scratch,'fixture.json')
  const env={...process.env,...config,P3_UI_FIXTURE:fixture,NODE_OPTIONS:'--conditions=react-server'}
  const seed=spawnSync(process.execPath,['--import','tsx','scripts/p3-browser.ts',beforeMode?'--seed-before':'--seed-after'],{env,encoding:'utf8',maxBuffer:8e6})
  writeFileSync(`docs/evidence/p3/browser-${beforeMode?'before':'after'}-seed.log`,seed.stdout+seed.stderr)
  if(seed.status!==0)throw Error('P3 baseline seed failed')
  const f=JSON.parse(readFileSync(fixture,'utf8'))
  const port=await new Promise<number>(resolve=>{const s=createServer();s.listen(0,'127.0.0.1',()=>{const p=(s.address() as {port:number}).port;s.close(()=>resolve(p))})})
  const runtime:NodeJS.ProcessEnv={...env,NODE_OPTIONS:'',NODE_ENV:'production'},server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',String(port)],{env:runtime,stdio:['ignore','pipe','pipe']})
  let logs='';server.stdout.on('data',v=>{logs+=v});server.stderr.on('data',v=>{logs+=v})
  const browser=await chromium.launch({headless:true,channel:'chromium'}),page=await browser.newPage(),base='http://127.0.0.1:'+port,measurements:unknown[]=[]
  try {
    for(let n=0;n<120;n++){try{if((await fetch(base+'/login')).ok)break}catch{}if(n===119)throw Error('Baseline server did not become ready');await new Promise(r=>setTimeout(r,500))}
    await page.goto(base+'/login');await page.getByLabel('Email',{exact:true}).fill(f.email);await page.getByLabel('Password',{exact:true}).fill(f.password);await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.waitForURL(u=>!u.pathname.startsWith('/login'),{timeout:60000})
    if(!beforeMode){await finalChecks(page,base,f,measurements);return}
    for(const width of [1440,900]) {
      await page.setViewportSize({width,height:1000})
      for(const route of ['opening','reports']) {
        await page.goto(base+`/ledger/${f.ledgerId}/`+route)
        await expect(page.locator('main h1')).toHaveText(route==='opening'?'Opening balances':'Reports',{timeout:60000})
        if(route==='opening')await expect(page.locator('input[name="description"]')).toBeVisible({timeout:60000})
        else await expect(page.getByRole('link',{name:'General ledger',exact:true})).toBeVisible({timeout:60000})
        await page.evaluate(async()=>{await document.fonts.ready})
        const data=await page.evaluate(()=>({elements:[...document.querySelectorAll('main input:not([type="hidden"]),main button,main a[href]')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0}).map(e=>{const r=e.getBoundingClientRect();return {tag:e.tagName,name:e.getAttribute('name'),text:e.textContent?.slice(0,100),x:r.x,y:r.y,width:r.width,height:r.height}}),documentOverflow:document.documentElement.scrollWidth>innerWidth+1}))
        if(!data.elements.length||data.documentOverflow)throw Error('Invalid loaded baseline geometry')
        measurements.push({route,width,...data});await page.screenshot({path:`docs/evidence/p3/browser-before-${route}-${width}.png`,fullPage:true})
      }
    }
    writeFileSync('docs/evidence/p3/browser-before-measurements.json',JSON.stringify({at:new Date().toISOString(),chronology:'Reference measurement of the current candidate; no historical timing claim',measurements},null,2)+'\n')
    console.log('PASS P3UI00 loaded opening and report reference controls measured at 1440/900\n=== ALL CHECKS PASSED ===')
  } finally {writeFileSync(`docs/evidence/p3/browser-${beforeMode?'before':'after'}-server.log`,logs);await browser.close();server.kill('SIGTERM')}
}
main().catch(e=>{console.error(e instanceof Error?e.message:'P3 browser failed');process.exitCode=1})
async function finalChecks(page:import('@playwright/test').Page,base:string,f:{beforeLedgerId:string;ledgerId:string;accounts:Array<{id:string;code:string}>;cust:string;sup:string;fiscalYearId:string},measurements:unknown[]) {
 const {HISTORY_CHART,ITEM_HEADER,HISTORY_START,HISTORY_END,HISTORY_OPEN,HISTORY_APPS,HISTORY_GL}=await import('./p3-fixtures')
 const pick=async(name:string,id:string,query:string)=>{const input=page.locator(`[data-picker="${name}"] input[role=combobox]`);await input.click();if(query)await input.fill(query);await page.locator(`[data-option="${id}"]:visible`).click()}
 const before=JSON.parse(readFileSync('docs/evidence/p3/browser-before-measurements.json','utf8')),checks:string[]=[],pass=(label:string)=>{checks.push(label);console.log('PASS '+label)}
 for(const width of [1440,900])for(const route of ['opening','reports']) {
  await page.setViewportSize({width,height:1000});await page.goto(base+`/ledger/${f.beforeLedgerId}/`+route)
  await expect(page.locator('main h1')).toHaveText(route==='opening'?'Opening balances':'Reports',{timeout:60000})
  await expect(route==='opening'?page.locator('input[name="description"]'):page.getByRole('link',{name:'General ledger',exact:true})).toBeVisible()
  await page.evaluate(async()=>{await document.fonts.ready})
  const after=await measure(page),original=before.measurements.find((m:{route:string;width:number})=>m.route===route&&m.width===width)
  for(const e of original.elements) {
   const match=after.elements.find(m=>m.tag===e.tag&&m.name===e.name&&m.text===e.text)
   if(!match||['x','y','width','height'].some(k=>Math.abs(match[k as 'x']-e[k])>1))throw Error(`Original ${route} geometry changed: ${e.name||e.text}`)
  }
  if(after.documentOverflow)throw Error('Original page has document overflow')
  measurements.push({route,width,...after});await page.screenshot({path:`docs/evidence/p3/browser-after-${route}-${width}.png`,fullPage:true})
 }
 pass('P3UI01 existing opening/report controls preserve measured geometry at 1440/900')
 await page.setViewportSize({width:1440,height:1000});await page.goto(base+`/ledger/${f.ledgerId}/opening/migration`)
 await page.getByLabel('Migration mode').selectOption('history');await page.getByLabel('Source system',{exact:true}).fill('Generic CSV browser fixture');await page.getByLabel('Source company identity').fill('UI-source-'+f.ledgerId)
 await pick('clearingAccountId',f.accounts.find(a=>a.code==='3999')!.id,'3999')
 await page.locator('input[name="fromDate"]').fill('2026-01-01');await page.locator('input[name="cutoffDate"]').fill('2026-03-31');await page.getByRole('button',{name:'Start isolated migration'}).click()
 await page.waitForURL(/opening\/migration\/[a-f0-9-]+$/);await expect(page.locator('[data-edit-protection]')).toContainText('Editing as',{timeout:60000})
 pass('P3UI02 real history wizard creates a protected draft in an empty target')
 for(const [kind,csv] of [['accounts',HISTORY_CHART],['starting_trial_balance',HISTORY_START],['starting_open_items',ITEM_HEADER+'\n'],['general_ledger',HISTORY_GL],['applications',HISTORY_APPS],['trial_balance',HISTORY_END],['open_items',HISTORY_OPEN]]) {
  await page.locator('select[name="kind"]').selectOption(kind);await page.locator('input[name="file"]').setInputFiles({name:kind+'.csv',mimeType:'text/csv',buffer:Buffer.from(csv)})
  await expect(page.getByLabel('Source column: source_account').or(page.getByLabel('Source column: source_id')).first()).toBeVisible({timeout:30000})
  await page.getByRole('button',{name:'Stage CSV with these formats'}).click()
  await expect(page.getByRole('link',{name:kind+'.csv',exact:true})).toBeVisible({timeout:60000})
 }
 pass('P3UI03 seven real CSV files pass explicit field/format staging')
 for(const a of f.accounts)await pick('account:'+a.code,a.id,a.code)
 await pick('party:CUST',f.cust,'');await pick('party:SUP',f.sup,'')
 await page.getByRole('button',{name:'Save mappings',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'Saved. Review the current status.'})).toBeVisible()
 await page.getByRole('button',{name:'Validate staging without posting'}).click();await expect(page.locator('main strong')).toHaveText('validated',{timeout:60000})
 pass('P3UI04 mapping and dry-run produce blocking-free reviewed source coverage')
 await page.getByRole('button',{name:'Approve this exact dataset'}).click();await expect(page.locator('main [role="alert"]')).toContainText('Confirm that you reviewed')
 await expect(page.locator('main strong')).toHaveText('validated')
 pass('P3UI05 missing human approval is refused and form remains available')
 await page.locator('input[name="reviewed"]').check();await page.getByRole('button',{name:'Approve this exact dataset'}).click();await expect(page.locator('main strong')).toHaveText('running',{timeout:60000})
 await page.getByRole('button',{name:'Run next batch',exact:true}).click();await expect(page.locator('main').getByText('source:INV1',{exact:true})).toBeVisible({timeout:60000})
 await page.getByRole('button',{name:'Run next batch',exact:true}).click();await expect(page.locator('main strong')).toHaveText('ready',{timeout:60000})
 pass('P3UI06 two bounded batches replay GL and applications to a real ready reconciliation')
 await page.locator('input[name="reconciled"]').check();await page.getByRole('button',{name:'Activate reconciled books'}).click();await expect(page.locator('main strong')).toHaveText('active',{timeout:60000})
 pass('P3UI07 explicit zero-difference review activates the target')
 const migrationUrl=page.url()
 await page.goto(base+`/ledger/${f.ledgerId}/reports/budgets`);await page.locator('input[name="name"]').fill('P3 browser budget');await page.locator('select[name="fiscalYearId"]').selectOption(f.fiscalYearId);await page.getByRole('button',{name:'Create protected draft'}).click();await page.waitForURL(/reports\/budgets\/[a-f0-9-]+$/)
 await expect(page.locator('[data-edit-protection]')).toContainText('Editing as',{timeout:60000})
 pass('P3UI08 unsaved budget gets a persisted empty draft and an edit lease')
 const field=page.locator('input[name^="cell:"]').first();await field.fill('123.45');await page.getByRole('button',{name:'Preview cell changes'}).click();await expect(page.getByText('1 affected cells · 0 existing cells overwritten')).toBeVisible({timeout:60000})
 await page.getByRole('button',{name:'Apply reviewed preview'}).click();await expect(page.locator('main [role="alert"]')).toContainText('Confirm the displayed');await expect(field).toHaveValue('123.45')
 pass('P3UI09 budget refusal preserves local money input')
 await page.locator('input[name="confirmOverwrite"]').check();await page.getByRole('button',{name:'Apply reviewed preview'}).click();await expect(page.getByRole('status').filter({hasText:'Saved. Review'})).toBeVisible()
 const budgetUrl=page.url()
 for(const width of [1440,900])for(const [route,url] of [['migration',migrationUrl],['budget',budgetUrl]]) {
  await page.setViewportSize({width,height:1000});await page.goto(url);await expect(page.locator('main h1')).toHaveText(route==='migration'?'Migration review':'P3 browser budget',{timeout:60000})
  await expect(page.locator('main h1')).toBeVisible({timeout:60000})
  if(route==='budget')await expect(page.locator('[data-edit-protection]')).toContainText(/Editing as|is editing until/,{timeout:60000})
  await expect(route==='budget'?page.getByRole('heading',{name:'Budget and actual comparison'}):page.getByRole('heading',{name:'Committed source references'})).toBeVisible({timeout:60000})
  await page.evaluate(async()=>{await document.fonts.ready;await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())))})
  const geometry=await measure(page);if(geometry.elements.length<3||geometry.documentOverflow)throw Error(route+' is not a loaded workspace or has document overflow')
  if(geometry.overlaps.length||geometry.badSvgs)throw Error(route+' has overlapping controls or an invalid SVG: '+JSON.stringify(geometry.overlaps))
  const bad=await page.evaluate(()=>[...document.querySelectorAll('main button')].filter(b=>{const r=b.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(b).visibility==='hidden'}).length)
  if(bad)throw Error('Invisible visible-sized buttons')
  measurements.push({route,width,...geometry});await page.screenshot({path:`docs/evidence/p3/browser-after-${route}-${width}.png`,fullPage:true,animations:'disabled'})
 }
 pass('P3UI10 new workspaces fit both viewports; horizontal matrix scrolling stays inside its container')
 await page.goto(budgetUrl);await expect(page.locator('[data-edit-protection]')).toContainText(/Editing as|is editing until/,{timeout:60000})
 if(await page.getByRole('button',{name:'Administrator takeover',exact:true}).isVisible())await page.getByRole('button',{name:'Administrator takeover',exact:true}).click()
 await expect(page.locator('[data-edit-protection]')).toContainText('Editing as',{timeout:60000});await page.getByRole('button',{name:'Publish immutable baseline'}).click();await expect(page.locator('main').getByText(/published · version/)).toBeVisible({timeout:30000})
 await expect(page.locator('input[name^="cell:"]')).toHaveCount(0)
 pass('P3UI11 published budget has no editable monthly cells')
 const revenueId=f.accounts.find(a=>a.code==='4000')!.id,drill=page.locator(`a[href*="breakdown?kind=account&account=${revenueId}"]`);await expect(drill).toHaveText('840.00');await expect(drill).toHaveAttribute('href',/from=2025-10-01&to=2026-09-30/)
 pass('P3UI12 actual figures link to existing account breakdown range')
 writeFileSync('docs/evidence/p3/browser-after-measurements.json',JSON.stringify({at:new Date().toISOString(),measurements,checks},null,2)+'\n')
 console.log('=== ALL CHECKS PASSED ===')
}
async function measure(page:import('@playwright/test').Page) {
 return page.evaluate(()=>{
  const controls=[...document.querySelectorAll('main input:not([type="hidden"]),main button,main a[href]')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'})
  const rectangles=controls.map(e=>e.getBoundingClientRect()),overlaps:string[]=[]
  for(let i=0;i<controls.length;i++)for(let j=i+1;j<controls.length;j++){
   if(controls[i].contains(controls[j])||controls[j].contains(controls[i])||controls[i].closest('[data-picker]')===controls[j].closest('[data-picker]')&&controls[i].closest('[data-picker]'))continue
   const a=rectangles[i],b=rectangles[j];if(Math.min(a.right,b.right)-Math.max(a.left,b.left)>1&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1)overlaps.push((controls[i].getAttribute('name')||controls[i].textContent?.slice(0,30))+' / '+(controls[j].getAttribute('name')||controls[j].textContent?.slice(0,30)))
  }
  return {elements:controls.map((e,i)=>{const r=rectangles[i];return {tag:e.tagName,name:e.getAttribute('name'),text:e.textContent?.slice(0,100),x:r.x,y:r.y,width:r.width,height:r.height}}),overlaps,badSvgs:[...document.querySelectorAll('main svg')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&(!e.getAttribute('viewBox')||!e.querySelector('path,circle,rect,line,polyline,polygon,text'))}).length,documentOverflow:document.documentElement.scrollWidth>innerWidth+1}
 })
}
