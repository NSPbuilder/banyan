import { chromium, expect } from '@playwright/test'
import { parse } from 'dotenv'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import postgres from 'postgres'

const root=process.cwd(),out=join(root,'docs/evidence/ui-completion-2026-10-08'),scratch=process.argv[2]
if(!scratch)throw Error('Pass the verified production build path')
const proof=JSON.parse(await readFile(join(root,'docs/evidence/p6/isolation.json'),'utf8'))
const cfg=parse(await readFile(proof.environmentPath))
if(!proof.createdNew||proof.productionTouched||new URL(cfg.DATABASE_URL).pathname.slice(1)!==proof.applicationDatabase)throw Error('Unconfirmed APP')
const fixture=JSON.parse(await readFile(join(out,'fixture.json'),'utf8')),f=JSON.parse(await readFile(fixture.privatePath,'utf8'))
const origin='http://localhost:3097',L=`/ledger/${f.ledgerId}`
const server=spawn('node',[join(scratch,'node_modules/next/dist/bin/next'),'start','--hostname','127.0.0.1','--port','3097'],{cwd:scratch,env:{...process.env,...cfg,NODE_OPTIONS:'',NODE_ENV:'production'},stdio:'ignore'})
const browser=await chromium.launch({headless:true}),ctx=await browser.newContext({viewport:{width:1440,height:1000}})
await ctx.addCookies([{name:'erp_session',value:f.token,domain:'localhost',path:'/'}])
const page=await ctx.newPage(),checks=[],errors=[],measurements=[]
page.on('pageerror',e=>errors.push(e.message))
const db=postgres(cfg.DATABASE_URL,{max:1})
function check(ok,label){assert.ok(ok,label);checks.push(label);console.log('PASS',label)}
async function go(path){await page.goto(origin+path,{waitUntil:'domcontentloaded'});await page.locator('main:not([aria-busy=true])').waitFor();await page.waitForTimeout(350);assert.notEqual(new URL(page.url()).pathname,'/login')}
async function focused(locator){await expect(locator).toBeFocused();return locator.evaluate(e=>document.activeElement===e)}
async function pick(label,text){const input=page.getByRole('combobox',{name:label,exact:true});await input.fill(text);await page.getByRole('option').filter({hasText:text}).first().click()}
async function safety(name){
 const result=await page.evaluate(()=>{
  const visible=e=>!!e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden'
  const fields=[...document.querySelectorAll('main input:not([type=hidden]), main select, main textarea')].filter(visible),overlaps=[]
  for(let i=0;i<fields.length;i++)for(let j=i+1;j<fields.length;j++){
   const a=fields[i].getBoundingClientRect(),b=fields[j].getBoundingClientRect()
   if(Math.min(a.right,b.right)-Math.max(a.left,b.left)>.5&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>.5)overlaps.push([fields[i].name,fields[j].name])
  }
  const blocked=fields.filter(e=>{const r=e.getBoundingClientRect();if(r.top<0||r.left<0||r.bottom>innerHeight||r.right>innerWidth)return false;const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return hit!==e&&!e.contains(hit)}).map(e=>e.name||e.getAttribute('aria-label'))
  const svg=[...document.querySelectorAll('main svg')].filter(visible),badSVG=svg.filter(e=>{const r=e.getBoundingClientRect();return !e.getAttribute('viewBox')||r.width<=0||r.height<=0}).length
  return {fields:fields.length,overlaps,blocked,badSVG,svg:svg.length,overflow:document.documentElement.scrollWidth-innerWidth}
 })
 measurements.push({name,...result});check(!result.overlaps.length&&!result.blocked.length&&!result.badSVG&&result.overflow===0,`${name}: fields do not overlap, centers are reachable, SVGs and document bounds are valid`)
}
try{
 let ready=false;for(let n=0;n<90;n++){try{if((await fetch(origin+'/login')).ok){ready=true;break}}catch{}await new Promise(resolve=>setTimeout(resolve,500))}assert.ok(ready)
 await mkdir(join(out,'screens'),{recursive:true})
 await go(L+'/entries/new')
 await pick('Account on line 1','Unused petty cash');await pick('Account on line 2','Consulting revenue')
 await page.getByRole('textbox',{name:'Description',exact:true}).fill('UI browser draft · synthetic')
 await page.getByRole('textbox',{name:'Debit on line 1',exact:true}).fill('100')
 await page.getByRole('textbox',{name:'Credit on line 2',exact:true}).fill('100')
 const post=page.getByRole('button',{name:'Post',exact:true})
 check(await post.isEnabled(),'complete balanced journal can reach its controlled post action')
 const bad=page.getByRole('textbox',{name:'Debit on line 3',exact:true});await bad.fill('1.234')
 check(await post.isDisabled()&&await bad.getAttribute('aria-invalid')==='true'&&!await bad.evaluate(e=>e.validity.valid),'invalid third amount blocks Post and native validity despite equal readable totals')
 check((await page.locator('.journal-totals').innerText()).includes('partial')&&!(await page.locator('.journal-totals').innerText()).includes('Balanced'),'invalid totals explicitly say partial')
 await page.screenshot({path:join(out,'screens/journal-invalid-1440.png'),fullPage:true})
 await bad.fill('');await page.getByRole('button',{name:'Save draft',exact:true}).click()
 await page.getByRole('status').filter({hasText:'Saved'}).first().waitFor({timeout:20000})
 const [draft]=await db`SELECT id::text,status FROM journal_entry WHERE ledger_id=${f.ledgerId}::uuid AND description='UI browser draft · synthetic' ORDER BY created_at DESC LIMIT 1`
 check(draft?.status==='draft','browser Save draft persists a real draft through the existing action')
 const sourceKey=await page.locator('[data-line]').nth(1).getAttribute('data-line')
 await page.getByRole('textbox',{name:'Description on line 2',exact:true}).fill('Copy identity');await page.getByRole('textbox',{name:'Description on line 2',exact:true}).press('Control+d')
 check(await page.getByRole('textbox',{name:'Description on line 3',exact:true}).inputValue()==='Copy identity'&&await page.locator('[data-line]').nth(2).getAttribute('data-line')!==sourceKey,'journal keyboard duplicate allocates a new identity and keeps values')
 await page.getByRole('textbox',{name:'Description on line 3',exact:true}).press('Shift+Enter')
 check(await focused(page.getByRole('textbox',{name:'Description on line 2',exact:true})),'Shift Enter moves vertically to the same column')
 await page.getByRole('button',{name:'Delete line 3',exact:true}).click()
 const widthBefore=await page.getByRole('textbox',{name:'Description on line 1',exact:true}).evaluate(e=>e.getBoundingClientRect().width)
 await page.getByRole('button',{name:'Party & tax',exact:true}).click();await pick('Party on line 1','Northwind')
 await page.getByRole('combobox',{name:'Tax on line 1',exact:true}).selectOption('GST')
 await page.getByRole('button',{name:'Party & tax',exact:true}).click()
 const payload=JSON.parse(await page.locator('input[name=lines]').inputValue())
 check(payload[0].partyId===f.partyId&&payload[0].taxCode==='GST','hiding optional journal columns preserves submitted party and tax values')
 measurements.push({name:'journal description',width:widthBefore});await safety('journal')
 await go(L+'/invoices/new')
 await pick('Account on line 1','Consulting revenue')
 const amount=page.getByRole('textbox',{name:'Amount on line 1',exact:true});await amount.fill('1.234')
 check(await amount.getAttribute('aria-invalid')==='true'&&!await amount.evaluate(e=>e.validity.valid),'invoice invalid amount exposes an accessible native refusal')
 check((await page.locator('.journal-totals').innerText()).includes('Partial total'),'invoice unreadable total is labelled partial')
 await amount.fill('123.45');await page.getByRole('combobox',{name:'Tax on line 1',exact:true}).selectOption('GST')
 await page.getByRole('textbox',{name:'GST on line 1',exact:true}).fill('10.23')
 await page.getByRole('textbox',{name:'Description on line 1',exact:true}).fill('Tax override copy');await amount.press('Control+d')
 check(await page.getByRole('textbox',{name:'Amount on line 2',exact:true}).inputValue()==='123.45'&&await page.locator('input[name="line.1.gst"]').inputValue()==='10.23','invoice keyboard duplicate preserves the actual tax override')
 await page.getByRole('textbox',{name:'GST on line 1',exact:true}).press('Enter')
 check(await focused(page.getByRole('textbox',{name:'GST on line 2',exact:true})),'tax override Enter stays in the grid instead of submitting the invoice')
 check((await page.locator('[data-typed-total]').innerText())==='267.36','duplicated invoice exact total includes both actual tax overrides')
 await page.getByRole('button',{name:'Remove line 1',exact:true}).click()
 check(await page.getByRole('textbox',{name:'Amount on line 1',exact:true}).inputValue()==='123.45'&&await page.locator('input[name="line.0.gst"]').inputValue()==='10.23','deleting the source renumbers the copied invoice without losing tax values')
 await page.getByRole('textbox',{name:'Description on line 1',exact:true}).press('Enter')
 check(await focused(page.getByRole('textbox',{name:'Description on line 2',exact:true})),'invoice Enter follows the same vertical grid interaction')
 const handle=page.getByRole('button',{name:'Reorder line 1',exact:true});await handle.press('Space');await handle.press('ArrowDown');await handle.press('Space')
 await expect(page.getByRole('textbox',{name:'Amount on line 2',exact:true})).toHaveValue('123.45')
 check(await page.getByRole('textbox',{name:'Amount on line 2',exact:true}).inputValue()==='123.45','invoice keyboard reorder moves the complete stable row')
 const newPosition=await page.locator('[data-line-row]').count()+1
 await page.getByRole('button',{name:'Add a line',exact:true}).click()
 check(await focused(page.getByRole('combobox',{name:`Account on line ${newPosition}`,exact:true})),'adding an invoice row focuses its visible account picker')
 await page.keyboard.press('Escape') // Measure the workspace after dismissing the account picker.
 await safety('invoice');await page.screenshot({path:join(out,'screens/invoice-grid-1440.png'),fullPage:true})
 await go(L+'/bills/new');await pick('Account on line 1','Office supplies')
 await page.getByRole('textbox',{name:'Amount on line 1',exact:true}).fill('45.67');await page.getByRole('button',{name:'Duplicate line 1',exact:true}).click()
 check(await page.getByRole('textbox',{name:'Amount on line 2',exact:true}).inputValue()==='45.67','bill uses the same copy and amount interaction');await safety('bill')
 await go(L+'/invoices?from=2026-10-01&to=2026-10-31&q=UI')
 const summary=page.locator('.ui-context-directory > summary');await summary.click()
 await page.getByRole('searchbox',{name:'Find customers',exact:true}).fill('Northwind')
 await page.getByRole('navigation',{name:'Customers list',exact:true}).getByRole('link').filter({hasText:'Northwind'}).click();await page.waitForTimeout(450)
 const qs=new URL(page.url()).searchParams
 check(qs.get('party')===f.partyId&&qs.get('from')==='2026-10-01'&&qs.get('to')==='2026-10-31'&&qs.get('q')==='UI','context directory retains the existing URL filters')
 await summary.click();await page.keyboard.press('Escape')
 check(!await page.locator('.ui-context-directory').evaluate(e=>e.open)&&await focused(summary),'context Escape closes and restores focus')
 const mainX=await page.locator('main').evaluate(e=>e.getBoundingClientRect().x);check(mainX===224,'invoice workspace no longer pays for a second permanent rail')
 await page.getByRole('link',{name:'New invoice',exact:true}).click();await page.locator('.overlay-header h2').waitFor()
 const dialog=page.getByRole('dialog',{name:/New invoice/})
 check(await dialog.count()===1&&await page.locator('.ledger-canvas').evaluate(e=>e.inert),'routed overlay has its real accessible title and inert background')
 await page.locator('.overlay-content input[name=note]').fill('Unsaved overlay test');await page.keyboard.press('Escape')
 await page.getByRole('dialog',{name:'Discard unsaved changes?',exact:true}).waitFor()
 await page.getByRole('button',{name:'Keep editing',exact:true}).click();check(await dialog.count()===1,'overlay keeps unsaved changes when requested')
 await page.keyboard.press('Escape');await page.getByRole('button',{name:'Discard changes',exact:true}).click();await page.locator('.overlay-panel').waitFor({state:'detached'})
 check(new URL(page.url()).searchParams.get('party')===f.partyId&&!await page.locator('.ledger-canvas').evaluate(e=>e.inert),'overlay dismissal restores the launching filtered workspace')
 await go(L+'/invoices?q=NO_UI_MATCH_987654')
 check((await page.locator('main').innerText()).includes('No invoices match these filters.'),'actual filtered query renders the empty state')
 await go(L+'/invoices?from=invalid')
 check((await page.locator('main').getByRole('alert').innerText()).includes('Enter valid issued dates.'),'actual invalid date query renders the error state')
 await go(L+'/invoices')
 const sort=page.getByRole('button',{name:'Sort by Amount',exact:true});await sort.click()
 check(await page.locator('th[aria-sort=descending]').count()===1,'amount sorting announces descending order')
 const firstAmount=await page.locator('tr[data-row] td').last().innerText()
 check((await page.locator('tr[data-row]').first().innerText()).includes('90,071,992,547,409.93'),'exact amount sort puts the large invoice first')
 await sort.click();check(await page.locator('th[aria-sort=ascending]').count()===1,'amount sort toggles to ascending order')
 void firstAmount
 await go(L+'/accounts');const search=page.getByRole('searchbox',{name:'Search chart of accounts'});await search.focus()
 check(await search.evaluate(e=>document.activeElement===e&&getComputedStyle(e).outlineStyle==='solid'&&getComputedStyle(e).outlineWidth==='2px'),'shared controls have a visible keyboard focus outline')
 check((await page.locator('main').innerText()).includes('0.00')&&(await page.locator('main').innerText()).includes('—'),'chart distinguishes a real zero from an inapplicable period balance')
 await page.getByRole('link' ,{name:'Add an account',exact:true}).click();await page.locator('.overlay-header h2').waitFor()
 check((await page.locator('.overlay-header h2').innerText())==='New account','legacy body headings also register the actual overlay title')
 await go('/settings/security')
 const manage=page.getByRole('button',{name:/Manage passkey/}).first();await manage.click()
 const keyDialog=page.getByRole('dialog',{name:/Passkey ·/});await keyDialog.waitFor()
 check(await keyDialog.getByLabel('Alternative password (required for your last passkey)').count()===1,'compact passkey rows retain the alternative credential controls on demand')
 await page.keyboard.press('Escape');check(await focused(manage),'native management dialog restores its opener')
 await safety('security');await page.screenshot({path:join(out,'screens/security-compact-1440.png'),fullPage:true})
 await go('/audit');const advanced=page.locator('.ui-more-filters');check(!await advanced.evaluate(e=>e.open),'audit starts with compact common filters')
 await advanced.locator('summary').click();await page.locator('select[name=actor]').selectOption(f.email);await page.getByRole('button',{name:'Apply',exact:true}).click();await page.waitForTimeout(450)
 check(new URL(page.url()).searchParams.get('actor')===f.email&&await page.locator('.ui-more-filters').evaluate(e=>e.open),'audit advanced values submit and reopen as active filters')
 check((await page.locator('main tbody time').first().innerText()).includes('UTC'),'audit timestamps have a consistent explicit zone')
 check(await page.locator('tr[data-audit]').count()===50,'audit only renders the current 50-record slice')
 await page.getByRole('navigation',{name:'Audit pages'}).getByRole('link',{name:'Next'}).click();await page.waitForURL(/page=2/)
 check(new URL(page.url()).searchParams.get('actor')===f.email,'audit pagination retains the existing actor filter')
 await go(L+'/projects/'+f.projectId)
 const grids=await page.evaluate(()=>['Revenue','Costs','Payment records'].map(label=>{
  const section=[...document.querySelectorAll('section')].find(s=>s.querySelector('h2')?.textContent.startsWith(label))
  const table=[...section.querySelectorAll('table')].find(t=>t.getClientRects().length)
  return [...table.tHead.rows[0].cells].map(c=>({label:c.textContent,x:c.getBoundingClientRect().x,width:c.getBoundingClientRect().width}))
 }))
 const aligned=(a,b)=>Math.abs(a.x-b.x)<1&&Math.abs(a.width-b.width)<1
 const column=(grid,label)=>grid.find(c=>c.label===label)
 check(grids.length===3&&grids.every(g=>['Date','Document no.'].every(label=>aligned(column(g,label),column(grids[0],label))))&&[['Total','Amount'],['Received','Allocated'],['Outstanding','Advance']].every(([record,payment])=>aligned(column(grids[0],record),column(grids[1],record==='Received'?'Paid':record))&&aligned(column(grids[0],record),column(grids[2],payment))),'Project Revenue, Cost and Payment records retain matching date, document and financial columns')
 measurements.push({name:'project shared columns',grids});await page.getByRole('link',{name:'Next',exact:true}).click();await page.waitForTimeout(450)
 check(new URL(page.url()).searchParams.get('page')==='2'&&(await page.locator('main').innerText()).includes('Page 2 of 2'),'Project pagination displays the actual second page')
 await go(L+'/automation/recurring');check(await page.getByRole('navigation',{name:'Back desk workspaces'}).locator('[aria-current=page]').count()===1,'Back desk has exactly one selected workspace')
 // Two real companies remain mounted: switching tabs must preserve unsaved form state.
 const old=JSON.parse(await readFile(proof.browserFixturePath,'utf8')),B=`/ledger/${old.ledgerId}/accounts`
 await page.addInitScript(({A,B})=>localStorage.setItem('erp.desk.v1',JSON.stringify({tabs:[{id:'t900',href:A},{id:'t901',href:B}],active:'t900'})),{A:L+'/entries/new',B})
 await page.goto(origin+'/',{waitUntil:'domcontentloaded'});await page.locator('iframe').first().waitFor();await page.waitForTimeout(700)
 const frame=page.frameLocator('iframe').first(),description=frame.getByRole('textbox',{name:'Description',exact:true})
 await description.fill('Unsubmitted company-specific work')
 const tabs=page.getByRole('tab');check(await tabs.count()===2&&await page.locator('iframe').count()===2,'two company workspaces stay mounted')
 await tabs.nth(1).click();await tabs.nth(0).click();check(await description.inputValue()==='Unsubmitted company-specific work','switching companies preserves unsaved tab state')
 check(errors.length===0,'no browser runtime errors during tested workflows')
}catch(error){await page.screenshot({path:join(out,'screens/interaction-failure.png'),fullPage:true}).catch(()=>{});errors.push(error.message);throw error}
finally{await writeFile(join(out,'interactions.json'),JSON.stringify({checks,measurements,errors,isolatedDatabase:proof.applicationDatabase},null,2)+'\n');await db.end();await browser.close();server.kill('SIGTERM')}
