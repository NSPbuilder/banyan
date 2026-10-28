import {chromium,expect} from '@playwright/test'
import {readFileSync,writeFileSync} from 'node:fs'
import {spawn} from 'node:child_process'
import {createServer} from 'node:net'
import {parse} from 'dotenv'
import postgres from 'postgres'
async function main(){
 const isolation=JSON.parse(readFileSync('docs/evidence/p3/isolation.json','utf8')),config=parse(readFileSync(isolation.environmentPath))
 if(new URL(config.DATABASE_URL).pathname.slice(1)!==isolation.applicationDatabase||!isolation.createdNew||isolation.productionTouched)throw Error('Unconfirmed P3 APP')
 const beforeMode=process.argv.includes('--before'),evidence='docs/evidence/p3',beforePath=evidence+'/source-browser-before.json'
 let ids:{ledgerId:string;runId:string;invoiceId:string;entryId:string;fileId:string}
 if(beforeMode){const c=postgres(config.DATABASE_URL,{max:1});try{const [r]=await c`SELECT r.ledger_id::text AS "ledgerId",r.run_id::text AS "runId",r.invoice_id::text AS "invoiceId",r.entry_id::text AS "entryId",(r.source_rows->0->>'fileId') AS "fileId" FROM migration_reference r JOIN migration_run m ON m.id=r.run_id WHERE m.status='active' AND r.source_key='source:INV1' ORDER BY m.created_at DESC LIMIT 1`;if(!r)throw Error('No real imported document');ids=r as typeof ids}finally{await c.end()}}
 else ids=JSON.parse(readFileSync(beforePath,'utf8')).ids
 const owner=JSON.parse(readFileSync(isolation.browserBaselineFixturePath,'utf8')),port=await new Promise<number>(resolve=>{const s=createServer();s.listen(0,'127.0.0.1',()=>{const p=(s.address() as {port:number}).port;s.close(()=>resolve(p))})}),base='http://127.0.0.1:'+port
 const server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',String(port)],{env:{...process.env,...config,NODE_ENV:'production',NODE_OPTIONS:''},stdio:['ignore','pipe','pipe']});let logs='';server.stdout.on('data',v=>logs+=v);server.stderr.on('data',v=>logs+=v)
 const browser=await chromium.launch({headless:true,channel:'chromium'}),page=await browser.newPage(),measurements:unknown[]=[]
 try{
  for(let n=0;n<120;n++){try{if((await fetch(base+'/login')).ok)break}catch{}if(n===119)throw Error('Source browser server unavailable');await new Promise(r=>setTimeout(r,500))}
  await page.goto(base+'/login');await page.getByLabel('Email',{exact:true}).fill(owner.email);await page.getByLabel('Password',{exact:true}).fill(owner.password);await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.waitForURL(u=>!u.pathname.startsWith('/login'),{timeout:60000})
  const prior=beforeMode?null:JSON.parse(readFileSync(beforePath,'utf8'))
  for(const width of [1440,900])for(const type of ['invoice','entry']){
   await page.setViewportSize({width,height:1000});await page.goto(base+`/ledger/${ids.ledgerId}/${type==='invoice'?'invoices/'+ids.invoiceId:'entries/'+ids.entryId}`)
   await expect(page.locator('main h1')).toBeVisible({timeout:60000});await expect(page.locator('main table').first()).toBeVisible({timeout:60000})
   if(!beforeMode)await expect(page.getByRole('link',{name:'general_ledger.csv · source lines 2, 3, 4',exact:true})).toBeVisible({timeout:60000})
   await page.evaluate(async()=>{await document.fonts.ready})
   const data=await page.evaluate(()=>{
    const elements=[...document.querySelectorAll('main input:not([type=hidden]),main button,main a[href]')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0}).map(e=>{const r=e.getBoundingClientRect();return {tag:e.tagName,name:e.getAttribute('name'),text:e.textContent?.slice(0,150),x:r.x,y:r.y,width:r.width,height:r.height}})
    return {elements,documentOverflow:document.documentElement.scrollWidth>innerWidth+1}
   });if(!data.elements.length||data.documentOverflow)throw Error('Source page not loaded or overflowed')
   if(prior){const old=prior.measurements.find((m:{type:string;width:number})=>m.type===type&&m.width===width),occurrences=new Map<string,number>();for(const e of old.elements){const key=JSON.stringify([e.tag,e.name,e.text]),ordinal=occurrences.get(key)??0;occurrences.set(key,ordinal+1);const same=data.elements.filter(x=>x.tag===e.tag&&x.name===e.name&&x.text===e.text)[ordinal];if(!same||['x','y','width','height'].some(k=>Math.abs(same[k as 'x']-e[k])>1))throw Error('Original document geometry changed: '+JSON.stringify({old:e,after:same}))}}
   measurements.push({type,width,...data});await page.screenshot({path:evidence+`/source-browser-${beforeMode?'before':'after'}-${type}-${width}.png`,fullPage:true,animations:'disabled'})
  }
  if(!beforeMode){const response=await page.request.get(base+`/ledger/${ids.ledgerId}/opening/migration/${ids.runId}/source/${ids.fileId}`);if(response.status()!==200||!(await response.text()).includes('INV1,,3,2026-01-05'))throw Error('Authorized original CSV download did not return real source rows')}
  writeFileSync(beforeMode?beforePath:evidence+'/source-browser-after.json',JSON.stringify({at:new Date().toISOString(),ids,measurements},null,2)+'\n');console.log(beforeMode?'PASS P3UI13 document/journal controls measured as the current source-area reference\n=== ALL CHECKS PASSED ===':'PASS P3UI14 original document/journal controls retain measured geometry at 1440/900\nPASS P3UI15 imported document and journal link to real private CSV physical source lines\n=== ALL CHECKS PASSED ===')
 }finally{writeFileSync(evidence+`/source-browser-${beforeMode?'before':'after'}-server.log`,logs);await browser.close();server.kill('SIGTERM')}
}
main().catch(e=>{console.error(e instanceof Error?e.message:'Source browser failed');process.exitCode=1})
