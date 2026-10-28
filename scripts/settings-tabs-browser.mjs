/** Real Settings actions/navigation in the confirmed synthetic APP; no external requests. */
import {chromium,expect} from '@playwright/test'
import {readFile,writeFile} from 'node:fs/promises'
import {parse} from 'dotenv'
import postgres from 'postgres'
import assert from 'node:assert/strict'
import {createHash,createDecipheriv,randomBytes} from 'node:crypto'
const out='docs/evidence/settings-tabs-2026-10-09',proof=JSON.parse(await readFile('docs/evidence/workflow-placement-2026-10-09/isolation.json','utf8')),cfg=parse(await readFile(proof.environmentPath))
assert(proof.createdNew&&!proof.productionTouched);assert.equal(new URL(cfg.DATABASE_URL).pathname.slice(1),proof.applicationDatabase)
const db=postgres(cfg.DATABASE_URL,{max:1}),[identity]=await db`SELECT current_database() AS name`;assert.equal(identity.name,proof.applicationDatabase)
const fixture=JSON.parse(await readFile(out+'/fixture.json','utf8')),f=JSON.parse(await readFile(fixture.privatePath,'utf8')),pointer=JSON.parse(await readFile('docs/evidence/ui-completion-2026-10-08/fixture.json','utf8')),owner=JSON.parse(await readFile(pointer.privatePath,'utf8'))
const browser=await chromium.launch({headless:true}),errors=[],checks=[],measurements=[],origin='http://localhost:3000',L='/ledger/'+f.ledgerId
const check=(ok,label)=>{assert.ok(ok,label);checks.push(label);console.log('PASS',label)}
async function context(token){const c=await browser.newContext({viewport:{width:1440,height:1000}});await c.addCookies([{name:'erp_session',value:token,domain:'localhost',path:'/',httpOnly:true,sameSite:'Lax'}]);const page=await c.newPage();page.on('pageerror',e=>errors.push(e.message));return {c,page}}
async function go(page,path){await page.goto(origin+path,{waitUntil:'domcontentloaded'});await expect(page.locator('main[aria-busy=true]')).toHaveCount(0,{timeout:20000});await expect(page.locator('main')).toBeVisible()}
async function selected(page,label){const tabs=page.getByRole('navigation',{name:'Settings categories'}),current=tabs.locator('[aria-current=page]');await expect(current).toHaveCount(1);await expect(current).toHaveText(label)}
async function measure(page,name){const m=await page.locator('main').evaluate(e=>{const visible=n=>n.checkVisibility()&&!!n.getClientRects().length&&getComputedStyle(n).visibility!=='hidden',fields=[...e.querySelectorAll('input:not([type=hidden]),textarea,select')].filter(visible),overlaps=[];for(let i=0;i<fields.length;i++)for(let j=i+1;j<fields.length;j++){const a=fields[i].getBoundingClientRect(),b=fields[j].getBoundingClientRect();if(Math.min(a.right,b.right)-Math.max(a.left,b.left)>.5&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>.5)overlaps.push([fields[i].name,fields[j].name])}const blocked=fields.filter(n=>{const r=n.getBoundingClientRect();if(r.top<0||r.left<0||r.right>innerWidth||r.bottom>innerHeight)return false;return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)!==n}).map(n=>n.name);return {main:e.getBoundingClientRect().toJSON(),overflow:document.documentElement.scrollWidth-innerWidth,overlaps,blocked,badSvg:[...e.querySelectorAll('svg')].filter(visible).filter(n=>!n.getAttribute('viewBox')||n.getBoundingClientRect().width<=0).length}});measurements.push({name,...m});check(!m.overflow&&!m.overlaps.length&&!m.blocked.length&&!m.badSvg,name+' geometry, field overlap/hit targets and SVG valid')}
const path=(section,id=f.ledgerId)=>'/settings?section='+section+'&ledger='+id
const decrypt=blob=>{const v=Buffer.from(blob),d=createDecipheriv('aes-256-gcm',createHash('sha256').update(cfg.AI_KEY_SECRET.trim()).digest(),v.subarray(0,12));d.setAuthTag(v.subarray(12,28));return Buffer.concat([d.update(v.subarray(28)),d.final()]).toString()}
try{
  const admin=await context(owner.token),page=admin.page
  await go(page,path('appearance'));await selected(page,'Appearance')
  check(await page.locator('main input[name=theme]').count()>0&&await page.locator('main input[name=aiApiKey],main input[name=host]').count()===0,'Appearance contains only its settings category')
  await measure(page,'Appearance 1440');await page.screenshot({path:out+'/appearance-1440.png',fullPage:true})
  for(const [section,label] of [['ai','AI'],['documents','Documents'],['administration','Administration']]){
    await page.getByRole('navigation',{name:'Settings categories'}).getByRole('link',{name:label,exact:true}).click();await expect(page).toHaveURL(origin+path(section));await selected(page,label)
    check(await page.locator('main input[name=theme]').count()===0,label+' tab excludes Appearance form')
    if(section==='ai'){check(await page.locator('input[name=aiApiKey]').count()===1,'AI category owns the only credential editor');await page.locator('main details summary').filter({hasText:'Prices'}).click()}
    await measure(page,label+' 1440')
  }
  await page.getByRole('navigation',{name:'Settings categories'}).getByRole('link',{name:'Company services',exact:true}).click();await expect(page).toHaveURL(origin+'/settings/services?ledger='+f.ledgerId+'&section=email');await selected(page,'Company services')
  check(await page.locator('input[name=host]').count()===1&&await page.locator('main input[name=aiApiKey],main input[name=theme]').count()===0,'Company services uses nested SMTP tabs without unrelated forms');await measure(page,'Services 1440');await page.screenshot({path:out+'/services-1440.png',fullPage:true})
  await page.getByRole('navigation',{name:'Settings categories'}).getByRole('link',{name:'Security',exact:true}).click();await expect(page).toHaveURL(origin+'/settings/security?ledger='+f.ledgerId);await selected(page,'Security');check(await page.getByRole('heading',{name:'Account security',exact:true}).count()===1&&await page.locator('main input[name=host],main input[name=aiApiKey],main input[name=theme]').count()===0,'Security has its own category and retains company query');await measure(page,'Security 1440')
  check(new Set(measurements.map(m=>m.main.x+':'+m.main.width)).size===1,'Settings categories use a stable desktop content width and position')
  await go(page,L+'/readings');check(await page.getByRole('link',{name:'AI settings',exact:true}).count()===1&&await page.locator('input[name=aiApiKey]').count()===0,'Read & add links to Settings with no credential editor')
  await go(page,L+'/assistant');check(await page.getByRole('link',{name:'AI settings',exact:true}).count()===1&&await page.locator('input[name=aiApiKey]').count()===0,'Assistant links to Settings with no credential editor')
  await page.setViewportSize({width:1280,height:720});await go(page,L+'/documents');const signingLink=page.getByRole('link',{name:'connect Documenso in Settings',exact:true})
  const signingBefore=JSON.parse(await readFile(out+'/documents-link-before.json','utf8')),signingAfter=await signingLink.evaluate(e=>({href:e.getAttribute('href'),rect:e.getBoundingClientRect().toJSON()}))
  check(signingAfter.href===path('documents')+'#documenso'&&['x','y','width','height'].every(k=>signingBefore.rect[k]===signingAfter.rect[k]),'Documenso settings deep link points to Documents tab with unchanged geometry')
  await signingLink.click();await expect(page).toHaveURL(origin+path('documents')+'#documenso');await selected(page,'Documents');await expect(page.locator('#documenso')).toBeVisible();check(await page.locator('#documenso').isVisible(),'actual signing workflow opens its Settings tab and anchor');await page.setViewportSize({width:1440,height:1000})
  await go(page,L+'/automation/jobs');check(await page.locator('a[href="'+L+'/automation"]').innerText()==='Automation'&&await page.getByRole('heading',{name:'Back desk',exact:true}).count()===1,'Automation menu restored; Back desk task title retained')
  const primary=f.actors.find(a=>a.kind==='primary'),user=await context(primary.token),p=user.page,key='synthetic-'+randomBytes(28).toString('hex')
  await go(p,path('ai'));await selected(p,'AI');check(await p.getByRole('navigation',{name:'Settings categories'}).getByRole('link',{name:'Administration',exact:true}).count()===0,'ordinary user has no Administration tab')
  await p.getByLabel('API base URL',{exact:true}).fill('https://ai-review.example.test/v1');await p.getByLabel('Model',{exact:true}).fill('synthetic-review-model');await p.getByLabel('API key',{exact:true}).fill(key)
  await p.getByRole('button',{name:'Save AI settings',exact:true}).click();await expect(p.getByRole('button',{name:'Change',exact:true})).toBeVisible({timeout:20000})
  const [saved]=await db`SELECT key_enc,key_hint,model FROM user_ai_service WHERE user_id=${primary.userId}::uuid`
  check(saved?.model==='synthetic-review-model'&&decrypt(saved.key_enc)===key&&!Buffer.from(saved.key_enc).includes(Buffer.from(key)),'real Server Action saves personal encrypted AI key in existing table')
  const html=await (await user.c.request.get(origin+path('ai'))).text();check(!html.includes(key),'saved plaintext key never appears in Settings HTML/RSC')
  await go(p,path('ai'));await p.getByRole('button',{name:'Change',exact:true}).click();check(await p.getByLabel('API key · Saved',{exact:true}).inputValue()==='','saved key input is blank')
  await p.getByLabel('Model',{exact:true}).fill('synthetic-updated-model');await p.getByRole('button',{name:'Save AI settings',exact:true}).click();await expect(p.getByRole('button',{name:'Change',exact:true})).toBeVisible({timeout:20000})
  const [changed]=await db`SELECT key_enc,model FROM user_ai_service WHERE user_id=${primary.userId}::uuid`;check(changed.model==='synthetic-updated-model'&&decrypt(changed.key_enc)===key,'blank key retains actual saved key while changing model')
  await go(p,path('ai',f.other.id));check((await p.locator('main').innerText()).includes('synthetic-updated-model'),'personal AI service persists across two granted companies')
  const second=await context(f.actors.find(a=>a.kind==='other-user').token);await go(second.page,path('ai'));check(await second.page.getByLabel('Model',{exact:true}).inputValue()===''&&!(await second.page.locator('main').innerText()).includes('synthetic-updated-model'),'different user does not see another user AI configuration');await second.c.close()
  const restricted=await context(f.actors.find(a=>a.kind==='restricted').token);await go(restricted.page,path('ai'));check(await restricted.page.getByRole('button',{name:'Save AI settings',exact:true}).count()===0&&(await restricted.page.locator('main').innerText()).includes('require access'),'AI configuration retains original module requirement');await restricted.c.close()
  await go(p,path('ai'));await p.getByRole('button',{name:'Remove key',exact:true}).click();await expect(p.getByRole('button',{name:'Save AI settings',exact:true})).toBeVisible({timeout:20000});const rows=await db`SELECT 1 FROM user_ai_service WHERE user_id=${primary.userId}::uuid`;check(!rows.length,'Remove key executes existing clear action and deletes only own service')
  const audit=await db`SELECT action FROM audit_log WHERE table_name='user_ai_service' AND record_id=${primary.userId}`;check(audit.some(a=>a.action==='set_ai_service')&&audit.some(a=>a.action==='clear_ai_service'),'real save and remove retain existing audit trail')
  await measure(p,'AI 1440');await p.screenshot({path:out+'/ai-1440.png',fullPage:true})
  for(const width of [1280,390]){await p.setViewportSize({width,height:1000});await go(p,path('ai'));await measure(p,'AI '+width);await page.setViewportSize({width,height:1000});await go(page,'/settings/services?ledger='+f.ledgerId+'&section=email');await measure(page,'Services '+width)}
  check(!errors.length,'no browser runtime errors throughout real Settings workflow')
  await user.c.close();await admin.c.close()
}finally{await writeFile(out+'/browser.json',JSON.stringify({checks,errors,measurements,database:identity.name,externalAiRequests:false},null,2)+'\n');await browser.close();await db.end()}
