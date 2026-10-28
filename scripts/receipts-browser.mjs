import {readFileSync,writeFileSync,createWriteStream} from 'node:fs'
import {spawn,execFileSync} from 'node:child_process'
import {parse} from 'dotenv'
import {chromium,expect} from '@playwright/test'
const evidence=process.env.RECEIPTS_EVIDENCE??'docs/evidence/payment-receipts-2026-10-14',proof=JSON.parse(readFileSync(evidence+'/isolation.json'))
const env={...process.env,...parse(readFileSync(proof.environmentPath))},fixture=JSON.parse(readFileSync(proof.fixturePath))
if(!proof.createdNew||proof.productionTouched||new URL(env.DATABASE_URL).pathname.slice(1)!==proof.appDatabase||!/^figtree_receipt_app_[a-f0-9]+_test$/.test(proof.appDatabase))throw Error('Unconfirmed Receipt APP')
const baseline=process.argv.includes('--baseline'),origin='http://127.0.0.1:'+(baseline?'3110':'3111')
const server=spawn('npm',['run','start','--','--hostname','127.0.0.1','--port',baseline?'3110':'3111'],{cwd:baseline?proof.baselineBuildDirectory:proof.updatedSourceDirectory,env,stdio:['ignore','pipe','pipe']})
const log=createWriteStream(evidence+'/'+(baseline?'baseline':'browser')+'-server.log')
for(const stream of [server.stdout,server.stderr])stream.on('data',data=>log.write(data))
const report={checks:[],measurements:[],consoleErrors:[],passed:false}
let browser
const check=(ok,label)=>{if(!ok)throw Error(label);report.checks.push(label);console.log('PASS '+label)}
const base='/ledger/'+fixture.ledgerId
async function measure(page,kind){
 await page.evaluate(async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))})
 return page.evaluate(kind=>{
  const root=kind==='invoice'?document.querySelector('[data-payments-panel]'):document.querySelector('[id^="payment-"]')?.closest('section')
  const box=e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}}
  const rows=[...root.querySelectorAll('tr')].filter(row=>row.id.startsWith('payment-')||row.querySelector('form'))
  const overlaps=[]
  for(const row of rows){const controls=[...row.querySelectorAll('button,a')].filter(e=>e.getClientRects().length)
   for(let i=0;i<controls.length;i++)for(let j=i+1;j<controls.length;j++){
    const a=box(controls[i]),b=box(controls[j]);if(Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x)>1&&Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y)>1)overlaps.push([controls[i].textContent,controls[j].textContent])
   }
  }
  const links=[...root.querySelectorAll('[data-receipt-links] a, [data-project-receipt-link]')].map(e=>({text:e.textContent,href:e.getAttribute('href'),...box(e)}))
  const columns=[...root.querySelectorAll('thead th')].map(e=>({text:e.textContent,...box(e)}))
  return{kind,width:innerWidth,bodyScrollWidth:document.documentElement.scrollWidth,root:box(root),columns,overlaps,links,
   svg:[...root.querySelectorAll('svg')].filter(e=>e.getClientRects().length).map(e=>({...box(e),viewBox:e.getAttribute('viewBox')}))}
 },kind)
}
async function main(){
 for(let i=0;i<120;i++){if(server.exitCode!==null)throw Error('Isolated server exited');try{if((await fetch(origin+'/login')).ok)break}catch{};await new Promise(r=>setTimeout(r,250));if(i===119)throw Error('Isolated server readiness failed')}
 browser=await chromium.launch({headless:true,channel:'chromium'})
 const context=await browser.newContext({viewport:{width:1440,height:1000}})
 await context.addInitScript('globalThis.__name = fn => fn')
 await context.addCookies([{name:'erp_session',value:fixture.token,url:origin,httpOnly:true,sameSite:'Lax'}])
 const page=await context.newPage();page.on('pageerror',error=>report.consoleErrors.push(error.message))
 for(const colorScheme of ['light','dark']){
 await page.emulateMedia({colorScheme})
 for(const width of [1440,900,390]){
  await page.setViewportSize({width,height:width<640?844:1000})
  for(const kind of ['invoice','project']){
   await page.goto(origin+base+(kind==='invoice'?'/invoices/'+fixture.invoiceId:'/projects/'+fixture.projectId),{waitUntil:'networkidle'})
   await page.evaluate(mode=>{document.documentElement.dataset.mode=mode},colorScheme)
   await expect(page.locator(kind==='invoice'?'[data-payments-panel]':'#payment-'+fixture.projectPaymentId)).toBeVisible()
   const layout=await measure(page,kind);layout.colorScheme=colorScheme;report.measurements.push(layout)
   if(!baseline){
    check(!layout.overlaps.length&&layout.bodyScrollWidth<=width&&layout.svg.every(svg=>svg.width>0&&svg.height>0&&!!svg.viewBox),'layout-'+kind+'-'+colorScheme+'-'+width+' has no overlap, page overflow or broken icons')
    if(kind==='project'){
     const summary=await page.evaluate(()=>{
      const section=[...document.querySelectorAll('section')].find(s=>s.querySelector('h2')?.textContent==='Summary'),table=[...section.querySelectorAll('table')].find(t=>t.getClientRects().length),headers=[...table.tHead.rows[0].cells],bounds=e=>{const b=e.getBoundingClientRect();return{x:b.x,right:b.right}}
      return {columns:headers.length,totals:[...table.tBodies].map(body=>{const row=body.rows[body.rows.length-1];return{span:row.cells[0].colSpan,slots:[...row.cells].reduce((n,c)=>n+c.colSpan,0),values:[...row.cells].slice(1).map((c,i)=>({text:c.innerText,...bounds(c),header:headers[i+2].textContent,expected:bounds(headers[i+2])}))}})}
     })
     layout.summary=summary
     check(summary.columns===9&&summary.totals.every(t=>t.span===2&&t.slots===9&&t.values.every(v=>Math.abs(v.x-v.expected.x)<=1&&Math.abs(v.right-v.expected.right)<=1)),'summary-'+colorScheme+'-'+width+' all Revenue and Cost totals align with their nine financial headings')
     const grid=await page.evaluate(()=>{
      const box=e=>{const r=e.getBoundingClientRect();return{x:r.x,width:r.width}}
      const sections=['Revenue','Costs','Payment records'].map(label=>[...document.querySelectorAll('section')].find(s=>s.querySelector('h2')?.textContent.startsWith(label)))
      const tables=sections.map(s=>[...s.querySelectorAll('table')].find(t=>t.getClientRects().length&&[...t.querySelectorAll('thead th')].some(h=>h.textContent==='Document no.')))
      return tables.map((t,i)=>({kind:['revenue','cost','payment'][i],headers:[...t.tHead.rows[0].cells].map(h=>({text:h.textContent,...box(h)})),rows:[...t.tBodies[0].rows].map(r=>({party:r.cells[1].innerText,date:r.cells[2].innerText,dateSpan:r.cells[2].colSpan,settled:r.cells[i===2?5:7].innerText,number:r.cells[i===2?7:9].innerText,links:[...r.cells[i===2?7:9].querySelectorAll('a')].map(a=>({text:a.textContent,href:a.getAttribute('href')}))}))}))
     })
     layout.projectGrid=grid
     const header=(g,label)=>g.headers.find(h=>h.text===label),near=(a,b)=>Math.abs(a-b)<=1
     const revenue=grid[0],payment=grid[2]
     check(grid.every(g=>near(header(g,'Date').x,header(revenue,'Date').x)&&near(header(g,'Date').width,header(revenue,'Date').width)&&near(header(g,'Document no.').x,header(revenue,'Document no.').x)),'grid-'+colorScheme+'-'+width+' Date and Document no. align across Revenue, Costs and Payments')
     check(near(header(payment,'Amount').x,header(revenue,'Total').x)&&near(header(payment,'Allocated').x,header(revenue,'Received').x)&&near(header(payment,'Advance').x,header(revenue,'Outstanding').x),'money-'+colorScheme+'-'+width+' payment amounts keep the shared financial columns')
     check(grid.every(g=>g.rows.every(r=>/^2026-\d{2}-\d{2}$/.test(r.date)&&r.dateSpan===1&&!/HIDE-|Due |2026-\d{2}-\d{2}/.test(r.party)&&!/[A-Za-z]/.test(r.settled)&&(g.kind==='payment'?r.links.length===1:r.links.length<=1)&&r.number.trim()===(r.links[0]?.text.trim()??''))),'content-'+colorScheme+'-'+width+' separate dates and financial document numbers; unlinked operational records have empty document cells')
     check(payment.rows.every(r=>/^R-/.test(r.number)&&r.links[0].href.endsWith('/receipt/preview')),'receipt-'+colorScheme+'-'+width+' actual receipt numbers lead to HTML previews')
    }else check(await page.locator('[data-receipt-links]').evaluateAll(nodes=>nodes.every(n=>n.querySelectorAll('a').length===1)),'invoice-'+colorScheme+'-'+width+' retains one receipt control')
    const reachable=await page.locator('[data-receipt-links] a, [data-project-receipt-link]').evaluateAll(async links=>{
     const result=[]
     for(const link of links){link.focus();link.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=link.getBoundingClientRect();result.push({text:link.textContent,visible:b.left>=0&&b.right<=innerWidth&&b.top>=0&&b.bottom<=innerHeight})}
     return result
    })
    layout.focusedReceiptLinks=reachable;check(reachable.length>0&&reachable.every(l=>l.visible),'focus-'+kind+'-'+colorScheme+'-'+width+' receipt links are keyboard reachable')
    await page.evaluate(()=>{document.activeElement?.blur();for(const n of document.querySelectorAll('.table-scroll'))n.scrollLeft=0;window.scrollTo(0,0)})
   }
   await page.screenshot({path:evidence+'/'+(baseline?'before':'after')+'-'+kind+'-'+colorScheme+'-'+width+'.png',fullPage:true})
   if(!baseline&&kind==='project'){
    const projectURL=page.url(),link=page.locator('#payment-'+fixture.projectPaymentId+' [data-project-receipt-link]'),number=(await link.textContent()).trim()
    await link.click();const overlay=page.locator('.overlay-panel');await expect(overlay).toBeVisible();await expect(overlay.locator('[data-project-receipt]')).toBeVisible()
    const preview=await overlay.evaluate(root=>{const surface=root.querySelector('.overlay-surface'),b=surface.getBoundingClientRect();return{inside:b.x>=0&&b.right<=innerWidth&&b.y>=0&&b.bottom<=innerHeight,noOverflow:surface.scrollWidth<=surface.clientWidth,focus:root.contains(document.activeElement),text:root.innerText,history:[...root.querySelectorAll('table[aria-label="Payment history"] th')].map(h=>h.textContent)}})
    layout.preview=preview
    check(preview.inside&&preview.noOverflow&&preview.focus&&preview.text.includes(number)&&preview.history.join('|')==='Date|Amount paid'&&!preview.text.includes('PRIVATE'),'preview-'+colorScheme+'-'+width+' floating receipt fits, owns focus and shows the correct number and two-column history')
    await overlay.locator('.overlay-surface').evaluate(e=>{e.scrollTop=0});await page.screenshot({path:evidence+'/receipt-preview-'+colorScheme+'-'+width+'.png'})
    await page.keyboard.press('Escape');await expect(overlay).toHaveCount(0);check(page.url()===projectURL,'close-'+colorScheme+'-'+width+' Escape returns to the originating Project')
   }
  }
 }
 }
 if(baseline){writeFileSync(evidence+'/before-layout.json',JSON.stringify(report,null,2)+'\n');return}
 const before=JSON.parse(readFileSync(evidence+'/before-layout.json'))
 report.beforeAfter=report.measurements.filter(m=>m.kind==='project').map(now=>({width:now.width,colorScheme:now.colorScheme,before:before.measurements.find(m=>m.kind==='project'&&m.width===now.width)?.columns,after:now.columns}))
 const originalSummary=JSON.parse(readFileSync(evidence+'/summary-original-baseline.json')),summaryDifferences=[]
 for(const now of report.measurements.filter(m=>m.kind==='project')){
  const old=originalSummary.measurements.find(m=>m.width===now.width&&m.mode===now.colorScheme)
  now.summary.totals.forEach((total,i)=>total.values.forEach((value,j)=>{const prior=old.totals[i].values[j];if(value.text!==prior.text||Math.abs(value.x-prior.x)>1||Math.abs(value.right-prior.right)>1)summaryDifferences.push({width:now.width,colorScheme:now.colorScheme,group:i,column:j,before:prior,after:value})}))
 }
 report.summaryDifferences=summaryDifferences;check(!summaryDifferences.length,'Summary amounts and their financial-column positions match the explicitly captured runtime reference')
 const paths={invoice:base+'/invoices/'+fixture.invoiceId+'/payments/'+fixture.entryId+'/receipt',project:base+'/projects/'+fixture.projectId+'/payments/'+fixture.projectPaymentId+'/receipt',finance:base+'/projects/'+fixture.financeProjectId+'/payments/'+fixture.financePaymentId+'/receipt',supplier:base+'/invoices/'+fixture.billId+'/payments/'+fixture.supplierEntryId+'/receipt',entry:base+'/entries/'+fixture.advanceEntryId+'/receipt'}
 for(const [kind,path] of Object.entries(paths)){
  const response=await context.request.get(origin+path)
  check(response.status()===200&&response.headers()['content-type']==='application/pdf'&&response.headers()['cache-control']==='no-store'&&(await response.body()).subarray(0,5).toString()==='%PDF-','PDF-'+kind+' returns actual authorized receipt')
  writeFileSync(evidence+'/browser-'+kind+'-receipt.pdf',await response.body())
  const download=await context.request.get(origin+path+'?download=1')
  check(download.status()===200&&download.headers()['content-disposition'].startsWith('attachment;'),'download-'+kind+' uses attachment response')
 }
 await page.goto(origin+base+'/projects/'+fixture.projectId,{waitUntil:'networkidle'})
 const projectURL=page.url(),link=page.locator('#payment-'+fixture.projectPaymentId+' [data-project-receipt-link]'),number=(await link.textContent()).trim()
 await link.click();await expect(page.locator('[data-project-receipt]')).toBeVisible()
 const [download]=await Promise.all([page.waitForEvent('download'),page.locator('.overlay-panel').getByRole('link',{name:'Download PDF'}).click()])
 await download.saveAs(evidence+'/preview-download.pdf')
 check((await download.failure())===null&&execFileSync('pdftotext',['-layout',evidence+'/preview-download.pdf','-'],{encoding:'utf8'}).includes(number),'preview download produces a real PDF with the same receipt number')
 await page.keyboard.press('Escape');await expect(page.locator('.overlay-panel')).toHaveCount(0);await expect(page.locator('#payment-'+fixture.projectPaymentId)).toBeVisible();check(page.url()===projectURL,'PDF download and closing preserve the original Project')
 for(const kind of ['Revenue','Costs']){
  const section=page.locator('section').filter({has:page.locator('h2').filter({hasText:new RegExp('^'+kind)})}).last(),documentLink=section.locator('[data-project-document]').first(),documentNumber=(await documentLink.textContent()).trim()
  await documentLink.click();await expect(page.locator('.overlay-panel')).toBeVisible();check((await page.locator('.overlay-panel').innerText()).includes(documentNumber),kind+' document number opens its existing financial form');await page.keyboard.press('Escape');await expect(page.locator('.overlay-panel')).toHaveCount(0)
 }
 const previewPath=paths.project+'/preview'
 await page.goto(origin+previewPath,{waitUntil:'networkidle'});await expect(page.locator('[data-project-receipt]')).toBeVisible();check(await page.locator('.overlay-panel').count()===0,'receipt deep link renders the same preview as a standalone page')
 if(fixture.archivedProjectId){
  await page.goto(origin+base+'/projects/'+fixture.archivedProjectId,{waitUntil:'networkidle'})
  const legacy=page.locator('#payment-'+fixture.archivedProjectPaymentId+' [data-project-receipt-link]'),legacyNumber=(await legacy.textContent()).trim()
  await legacy.click();await expect(page.locator('[data-project-receipt]')).toBeVisible();check((await page.locator('[data-project-receipt]').innerText()).includes(legacyNumber),'archived operational payment retains its exact receipt number and read-only preview')
  const fits=await page.locator('.overlay-surface').evaluate(e=>e.scrollWidth<=e.clientWidth);check(fits,'long operational receipt numbers fit the narrow preview')
 }
 const badPreview=await context.request.get(origin+'/ledger/'+fixture.foreignLedgerId+'/projects/'+fixture.projectId+'/payments/'+fixture.projectPaymentId+'/receipt/preview',{maxRedirects:0})
 check(badPreview.status()===404||(badPreview.status()===307&&badPreview.headers().location.includes('/no-access')),'cross-company receipt preview is unavailable')
 await page.goto(origin+base+'/entries/'+fixture.advanceEntryId,{waitUntil:'networkidle'})
 await expect(page.locator('[data-receipt-links] a')).toHaveCount(1);check(true,'standalone payment entry exposes one Receipt link')
 const wrong=await context.request.get(origin+'/ledger/'+fixture.foreignLedgerId+'/entries/'+fixture.entryId+'/receipt')
 check(wrong.status()===404,'cross-company receipt identifier returns no document')
 const invalid=await context.request.get(origin+base+'/entries/'+fixture.invalidEntryId+'/receipt')
 check(invalid.status()===404,'reversed payment has no HTTP receipt')
 const cancelled=await context.request.get(origin+base+'/projects/'+fixture.projectId+'/payments/'+fixture.invalidProjectPaymentId+'/receipt')
 check(cancelled.status()===404,'cancelled Project payment has no HTTP receipt')
 const anonymous=await browser.newContext(),unauth=await anonymous.request.get(origin+paths.invoice,{maxRedirects:0})
 check([401,307].includes(unauth.status()),'unauthenticated receipt request is refused');await anonymous.close()
 const denied=await browser.newContext();await denied.addCookies([{name:'erp_session',value:fixture.deniedToken,url:origin,httpOnly:true,sameSite:'Lax'}])
 const forbidden=await denied.request.get(origin+paths.project)
 check(forbidden.status()===403,'user lacking the company cannot download its receipt');const deniedPreview=await denied.request.get(origin+previewPath,{maxRedirects:0});check(deniedPreview.status()===307&&deniedPreview.headers().location.includes('/no-access'),'receipt preview enforces the company grant');await denied.close()
 const projectOnly=await browser.newContext();await projectOnly.addCookies([{name:'erp_session',value:fixture.projectToken,url:origin,httpOnly:true,sameSite:'Lax'}])
 check((await projectOnly.request.get(origin+paths.finance)).status()===200&&(await projectOnly.request.get(origin+paths.invoice)).status()===403,'Project-only access permits Project receipt and preserves Invoice module gate');const allowedPreview=await projectOnly.request.get(origin+previewPath);check(allowedPreview.status()===200&&(await allowedPreview.text()).includes('data-project-receipt'),'Project-only user may preview the linked receipt without Invoice-module access');await projectOnly.close()
 check(!report.consoleErrors.length,'no browser runtime errors')
 report.passed=true;writeFileSync(evidence+'/browser-result.json',JSON.stringify(report,null,2)+'\n')
}
try{await main()}catch(error){console.error(error);writeFileSync(evidence+'/browser-failure.json',JSON.stringify({...report,error:String(error)},null,2)+'\n');process.exitCode=1}
finally{if(browser)await browser.close();server.kill('SIGTERM');await new Promise(r=>setTimeout(r,300));log.end()}
