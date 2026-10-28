/** Revenue descriptions through actual hydrated actions; isolated APP only. */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { resolve, join } from 'node:path'
import dotenv from 'dotenv'
import postgres from 'postgres'
import { chromium, expect } from '@playwright/test'

dotenv.config({ path: '.env.local', quiet: true })
const proof=JSON.parse(readFileSync(process.env.FIGTREE_TEST_ISOLATION_PROOF,'utf8'))
const url=new URL(process.env.DATABASE_URL)
assert(proof.createdNew&&!proof.productionTouched&&proof.initialTables===0)
assert.equal(url.pathname.slice(1),proof.applicationDatabase); assert.equal(url.hostname,'127.0.0.1'); assert.equal(Number(url.port),proof.pgPort)
assert.equal(statSync(proof.environmentPath).mode&0o777,0o600)
assert.equal(createHash('sha256').update(readFileSync(proof.environmentPath)).digest('hex'),proof.environmentSha256)
const fixture=JSON.parse(readFileSync(proof.fixturePath,'utf8')),phase=process.env.REVENUE_LINES_PHASE||'after'
const out=resolve(process.env.REVENUE_LINES_EVIDENCE_DIR||'docs/evidence/project-revenue-lines');mkdirSync(out,{recursive:true})
const origin=`http://127.0.0.1:${proof.appPort}`,projectPath=`/ledger/${fixture.ledgerId}/projects/${fixture.financeProjectId}`
const database=postgres(url.href,{max:2}),browser=await chromium.launch({headless:true}),context=await browser.newContext({viewport:{width:1440,height:1100}})
await context.addCookies([{name:'erp_session',value:fixture.token,url:origin,httpOnly:true,sameSite:'Lax'}])
const page=await context.newPage(),errors=[],checks=[],measurements=[]
page.on('pageerror',error=>errors.push(error.message))
const pass=label=>{checks.push(label);console.log('PASS '+label)}
// The hook's shared verifier file is absent. The explicit checks below cover
// actual geometry plus clipping and scroll reachability before/after the change.
const browser_evaluate=panel=>panel.evaluate(root=>{
 const box=el=>{const r=el.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}}
 const visible=el=>{const style=getComputedStyle(el),r=el.getBoundingClientRect();return style.display!=='none'&&style.visibility!=='hidden'&&r.width>0&&r.height>0}
 const controls=[...root.querySelectorAll('input:not([type=hidden]),textarea,select,button')].filter(visible)
 const overlaps=[]
 for(let i=0;i<controls.length;i++)for(let j=i+1;j<controls.length;j++){
  const a=box(controls[i]),b=box(controls[j]);if(Math.min(a.right,b.right)-Math.max(a.left,b.left)>.5&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>.5)
   overlaps.push([controls[i].getAttribute('aria-label')||controls[i].name||controls[i].textContent,controls[j].getAttribute('aria-label')||controls[j].name||controls[j].textContent])
 }
 const pairs=[...root.querySelectorAll('tbody tr')].flatMap(row=>{const description=row.querySelector('[name=lineDescription]'),amount=row.querySelector('[name=base]');if(!description||!amount)return [];const d=box(description),a=box(amount);return [{gap:a.left-d.right,sameRow:Math.abs((a.top+a.height/2)-(d.top+d.height/2))<1,descriptionWidth:d.width,amountWidth:a.width}]})
 const invalidSvgs=[...root.querySelectorAll('svg')].filter(el=>/NaN|Infinity|undefined/.test(el.outerHTML)).length
 const fields=[...root.querySelectorAll('input:not([type=hidden]),textarea,select')].filter(visible).map(el=>({name:el.name,ariaLabel:el.getAttribute('aria-label'),box:box(el),enabled:!el.disabled}))
 const scrollContainers=[]
 for(let el=root.querySelector('table')?.parentElement;el;el=el.parentElement){
  const style=getComputedStyle(el)
  if(/auto|scroll/.test(style.overflowX))scrollContainers.push({tag:el.tagName,className:el.className,clientWidth:el.clientWidth,scrollWidth:el.scrollWidth,horizontalOverflow:Math.max(0,el.scrollWidth-el.clientWidth)})
 }
 return {viewport:{width:innerWidth,height:innerHeight},dialog:box(root),fields,overlaps,pairs,invalidSvgs,descriptionFields:root.querySelectorAll('[name=lineDescription]').length,scrollContainers,tableOverflow:Math.max(0,...scrollContainers.map(el=>el.horizontalOverflow)),pageOverflow:document.documentElement.scrollWidth-innerWidth}
})
const measure=async(panel,width)=>{
 await page.setViewportSize({width,height:1100});const result=await browser_evaluate(panel)
 assert.deepEqual(result.overlaps,[]);assert.equal(result.invalidSvgs,0);assert(result.pageOverflow<=1)
 assert(result.fields.every(f=>f.box.width>0&&f.box.height>0))
 if(phase!=='before'){assert.equal(result.descriptionFields,2);assert(result.pairs.every(p=>p.sameRow&&p.gap>=6&&p.descriptionWidth>=120))}
 result.reachability=[]
 for(const control of await panel.locator('[name=lineDescription],[name=base]').all()){
  await control.scrollIntoViewIfNeeded()
  const reach=await control.evaluate(el=>{
   const r=el.getBoundingClientRect();let left=0,top=0,right=innerWidth,bottom=innerHeight
   for(let parent=el.parentElement;parent;parent=parent.parentElement){
    const style=getComputedStyle(parent),p=parent.getBoundingClientRect()
    if(/auto|scroll|hidden|clip/.test(style.overflowX)){left=Math.max(left,p.left+parent.clientLeft);right=Math.min(right,p.left+parent.clientLeft+parent.clientWidth)}
    if(/auto|scroll|hidden|clip/.test(style.overflowY)){top=Math.max(top,p.top+parent.clientTop);bottom=Math.min(bottom,p.top+parent.clientTop+parent.clientHeight)}
   }
   const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)
   return {name:el.name,ariaLabel:el.getAttribute('aria-label'),fullyUnclipped:r.left>=left-.5&&r.right<=right+.5&&r.top>=top-.5&&r.bottom<=bottom+.5,centerHitsControl:hit===el||el.contains(hit)}
  })
  assert(reach.fullyUnclipped&&reach.centerHitsControl,JSON.stringify(reach));result.reachability.push(reach)
 }
 measurements.push(result)
}
const recordFor=async summary=>(await database`SELECT r.id::text,r.version,i.id::text AS invoice_id,i.number,i.print_template_snapshot FROM project_record r JOIN project_accounting_link h ON h.record_id=r.id JOIN invoice i ON i.id=h.invoice_id WHERE r.project_id=${fixture.financeProjectId} AND r.description=${summary}`)[0]
const descriptions=async recordId=>Array.from(await database`SELECT description,base_cents::text FROM project_record_line WHERE record_id=${recordId} ORDER BY position`)
try{
 await page.goto(origin+projectPath);await page.getByRole('button',{name:'Add revenue',exact:true}).click()
 let panel=page.getByRole('dialog',{name:'Add revenue',exact:true})
 await panel.getByRole('button',{name:'Add line',exact:true}).click()
 await measure(panel,1440);await measure(panel,390);await page.setViewportSize({width:1440,height:1100})
 if(phase==='before'){
  assert.equal(measurements[0].descriptionFields,0)
  writeFileSync(join(out,'before-measurements.json'),JSON.stringify({measurements,errors,sharedVerifierAbsent:true},null,2)+'\n')
  console.log('PASS measured actual baseline: amount rows have no description inputs')
 }else if(process.env.REVENUE_LINES_LAYOUT_ONLY==='1'){
  const before=JSON.parse(readFileSync(join(out,'before-measurements.json'),'utf8'))
  assert.deepEqual(before.measurements.map(m=>m.viewport.width),measurements.map(m=>m.viewport.width));assert.deepEqual(errors,[])
  writeFileSync(join(out,'after-measurements.json'),JSON.stringify({measurements,errors,sharedVerifierAbsent:true,comparison:{beforeDescriptionFields:before.measurements.map(m=>m.descriptionFields),afterDescriptionFields:measurements.map(m=>m.descriptionFields),sameWidths:true,overlaps:0,invalidSvgs:0,allDescriptionAndAmountControlsUnclippedAndReachable:true}},null,2)+'\n')
  console.log('PASS fresh desktop/mobile before-after layout: all description and amount inputs fully unclipped and center-hit reachable after scrolling')
 }else{
  pass('desktop/mobile geometry has visible line descriptions beside amounts, positive spacing, no overlap, invalid SVG or page overflow')
  const summary='REVENUE-LINES-'+Date.now(),first='Design <concept> & planning',second='Installation services'
  await panel.locator('[name=description]').fill(summary)
  await panel.locator('[name=lineDescription]').nth(0).fill(first);await panel.locator('[name=base]').nth(0).fill('100.00')
  await panel.locator('[name=lineDescription]').nth(1).fill('Removed row');await panel.locator('[name=base]').nth(1).fill('900.00')
  await panel.getByRole('button',{name:'Add line',exact:true}).click()
  await panel.locator('[name=lineDescription]').nth(2).fill(second);await panel.locator('[name=base]').nth(2).fill('200.00')
  await panel.getByRole('button',{name:'Remove line 2',exact:true}).click()
  await expect(panel.locator('[name=lineDescription]')).toHaveCount(2);await expect(panel.locator('[name=lineDescription]').nth(1)).toHaveValue(second)
  await panel.getByRole('button',{name:'Add line',exact:true}).click()
  await panel.locator('[name=lineDescription]').nth(2).fill('Not billed');await panel.locator('[name=base]').nth(2).fill('0')
  await panel.locator('[name=dueDate]').fill('2020-01-01');await panel.getByRole('button',{name:'Save and post',exact:true}).click()
  await expect(panel.getByRole('alert')).toBeVisible();await expect(panel.locator('[name=lineDescription]').nth(0)).toHaveValue(first);await expect(panel.locator('[name=lineDescription]').nth(1)).toHaveValue(second)
  assert.equal(await recordFor(summary),undefined);pass('row removal preserves description/amount pairs and refused saves retain both descriptions')
  await panel.locator('[name=dueDate]').fill('');await panel.getByRole('button',{name:'Save and post',exact:true}).click()
  await expect.poll(async()=>!!await recordFor(summary)).toBe(true);const made=await recordFor(summary)
  await expect(panel.locator('form')).not.toHaveAttribute('data-pending','true');await expect(panel.locator('[name=description]')).toHaveValue('')
  await expect(panel.locator('[name=lineDescription]')).toHaveCount(1);await expect(panel.locator('[name=lineDescription]')).toHaveValue('')
  assert.deepEqual(await descriptions(made.id),[{description:first,base_cents:'10000'},{description:second,base_cents:'20000'}])
  const invoiceLines=async()=>Array.from(await database`SELECT description,amount::text FROM invoice_line WHERE invoice_id=${made.invoice_id} AND generated_for IS NULL ORDER BY line_no`)
  assert.deepEqual(await invoiceLines(),[{description:first,amount:'-10000'},{description:second,amount:'-20000'}])
  pass('real create action stores distinct source/Invoice lines and resets the form after success')
  await panel.getByRole('button',{name:'Close',exact:true}).click();await expect(page.getByRole('button',{name:'Keep editing',exact:true})).not.toBeVisible()
  await page.getByRole('button',{name:'Edit '+summary,exact:true}).click();panel=page.locator('dialog[open]')
  await expect(panel.locator('[name=lineDescription]').nth(0)).toHaveValue(first);await expect(panel.locator('[name=lineDescription]').nth(1)).toHaveValue(second)
  await panel.locator('[name=lineDescription]').nth(1).fill('Final installation');await panel.getByRole('button',{name:'Save changes',exact:true}).click()
  await expect.poll(async()=>(await descriptions(made.id))[1]?.description).toBe('Final installation');await expect(panel.locator('form')).not.toHaveAttribute('data-pending','true')
  assert.equal((await recordFor(summary)).invoice_id,made.invoice_id);assert.equal((await recordFor(summary)).number,made.number)
  assert.deepEqual(await invoiceLines(),[{description:first,amount:'-10000'},{description:'Final installation',amount:'-20000'}])
  await panel.getByRole('button',{name:'Close',exact:true}).click();await expect(page.getByRole('button',{name:'Keep editing',exact:true})).not.toBeVisible()
  pass('Edit prefills and saves each description on the same Invoice with its original number')
  await page.goto(origin+`/ledger/${fixture.ledgerId}/invoices/${made.invoice_id}`)
  await expect(page.getByText(first,{exact:true})).toBeVisible();await expect(page.getByText('Final installation',{exact:true})).toBeVisible()
  pass('Invoice detail HTML shows both escaped descriptions')
  const pdf=await context.request.get(origin+`/ledger/${fixture.ledgerId}/invoices/${made.invoice_id}/pdf`);assert(pdf.ok())
  const path=join(out,'invoice.pdf');writeFileSync(path,await pdf.body());const text=execFileSync('pdftotext',['-layout',path,'-'],{encoding:'utf8'})
  assert(text.includes(first)&&text.includes('Final installation')&&!text.includes('Removed row'));pass('actual Invoice PDF contains each saved line description')
  await page.goto(origin+projectPath);await page.getByRole('button',{name:'Add cost',exact:true}).click();panel=page.getByRole('dialog',{name:'Add cost',exact:true})
  await expect(panel.locator('[name=lineDescription]')).toHaveCount(0);await expect(panel.locator('[name=description]')).toBeVisible()
  pass('Cost form retains its original fields')
  assert.deepEqual(errors,[])
  const before=JSON.parse(readFileSync(join(out,'before-measurements.json'),'utf8'))
  assert.deepEqual(before.measurements.map(m=>m.viewport.width),measurements.map(m=>m.viewport.width))
  writeFileSync(join(out,'after-measurements.json'),JSON.stringify({measurements,errors,sharedVerifierAbsent:true,comparison:{beforeDescriptionFields:before.measurements.map(m=>m.descriptionFields),afterDescriptionFields:measurements.map(m=>m.descriptionFields),sameWidths:true,overlaps:0,invalidSvgs:0}},null,2)+'\n')
  writeFileSync(join(out,'browser.json'),JSON.stringify({checks,errors,passed:true,productionTouched:false},null,2)+'\n')
  console.log(`=== ALL CHECKS PASSED (${checks.length} real browser cases) ===`)
 }
}finally{await browser.close();await database.end()}
