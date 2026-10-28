import {readFileSync,writeFileSync,createWriteStream} from 'node:fs'
import {spawn} from 'node:child_process'
import {execFileSync} from 'node:child_process'
import {parse} from 'dotenv'
import postgres from 'postgres'
import {chromium,expect} from '@playwright/test'

// A real browser and Server Actions against the independently created APP.
// The proof and session are private validation inputs, never production data.
const evidence=process.env.PARTY_WORKFLOW_EVIDENCE??'docs/evidence/party-workflow-2026-10-13'
const proof=JSON.parse(readFileSync(evidence+'/isolation.json','utf8'))
const env={...process.env,...parse(readFileSync(proof.environmentPath))}
if(!proof.createdNew||proof.productionTouched||new URL(env.DATABASE_URL).pathname.slice(1)!==proof.appDatabase
  ||!/^figtree_party_app_[a-f0-9]+_test$/.test(proof.appDatabase))throw Error('Unconfirmed disposable Party APP')
const fixture=JSON.parse(readFileSync(proof.fixturePath,'utf8'))
const sql=postgres(env.DATABASE_URL,{max:1}),origin='http://127.0.0.1:3108'
const report={checks:[],measurements:[],consoleErrors:[],passed:false}
const runId=Date.now().toString(36)
const log=createWriteStream(evidence+'/browser-server.log')
const server=spawn('npm',['run','start','--','--hostname','127.0.0.1','--port','3108'],{cwd:proof.updatedSourceDirectory,env,stdio:['ignore','pipe','pipe']})
for(const output of [server.stdout,server.stderr])output.on('data',data=>log.write(data))
let browser,page
function check(value,label){if(!value)throw Error(label);report.checks.push(label);console.log('PASS '+label)}
async function snapshot(picker){return picker.evaluate(node=>[...new FormData(node.closest('form'))]
  .filter(([key])=>key!=='requestKey').map(([key,value])=>[key,typeof value==='string'?value:[value.name,value.size]]))}
function withoutParty(values,name='partyId'){return JSON.stringify(values.filter(([key])=>key!==name))}
async function openFromPicker(picker,title,typed){
  if(typed===undefined)await picker.click();else await picker.fill(typed)
  const box=picker.locator('xpath=..')
  await box.locator('[data-create]').click()
  const dialog=page.getByRole('dialog',{name:title,exact:true})
  await expect(dialog).toBeVisible({timeout:30000})
  await expect(dialog.locator('input[name="name"]')).toBeVisible()
  return dialog
}
async function measure(dialog,picker){
  await page.evaluate(async()=>{await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))})
  const popup=await dialog.evaluate(root=>{
    const box=root.getBoundingClientRect(),form=root.querySelector('form')
    const controls=[...form.querySelectorAll('input:not([type="hidden"]),select,textarea')].filter(e=>e.getClientRects().length)
    const rectangles=controls.map(e=>{const r=e.getBoundingClientRect();return{name:e.getAttribute('name')??e.textContent,x:r.x,y:r.y,width:r.width,height:r.height}})
    // A complete form scrolls vertically. Its controls must fit horizontally;
    // focus visibility and footer occlusion are checked independently below.
    const outside=rectangles.filter(r=>r.width<=0||r.height<=0||r.x<box.left-1||r.x+r.width>box.right+1)
    const overlaps=[]
    for(let i=0;i<rectangles.length;i++)for(let j=i+1;j<rectangles.length;j++){
      const a=rectangles[i],b=rectangles[j],w=Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x),h=Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y)
      if(w>1&&h>1)overlaps.push([a.name,b.name])
    }
    const svgs=[...root.querySelectorAll('svg')].map(e=>{const r=e.getBoundingClientRect();return{width:r.width,height:r.height,viewBox:e.getAttribute('viewBox')}})
    return{viewport:innerWidth,scrollWidth:document.documentElement.scrollWidth,scrollHeight:root.scrollHeight,dialog:{x:box.x,y:box.y,width:box.width,height:box.height},rectangles,outside,overlaps,svgs,
      nestedForm:!!form.parentElement.closest('form'),startInputs:form.querySelectorAll('[name="heldFrom"]').length}
  })
  const original=await picker.evaluate(node=>{const form=node.closest('form'),r=form.getBoundingClientRect()
    return{form:{x:r.x,y:r.y,width:r.width,height:r.height},controls:[...form.querySelectorAll('input:not([type="hidden"]),select,textarea')]
      .filter(e=>e.getClientRects().length&&!e.closest('[popover]')).map(e=>{const b=e.getBoundingClientRect();return{name:e.getAttribute('name'),label:e.getAttribute('aria-label'),x:b.x,y:b.y,width:b.width,height:b.height}})}})
  const focused=await dialog.evaluate(async root=>{
    const fields=[...root.querySelectorAll('input:not([type="hidden"]),select,textarea')],result=[]
    root.scrollTop=0
    for(const field of fields){
      field.focus()
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))
      const r=field.getBoundingClientRect(),panel=root.getBoundingClientRect(),footer=root.querySelector('.form-actions').getBoundingClientRect()
      result.push({name:field.name,visible:r.top>=panel.top&&r.bottom<=panel.bottom&&r.left>=panel.left&&r.right<=panel.right,
        coveredByFooter:r.bottom>footer.top&&r.top<footer.bottom})
    }
    return result
  })
  return{popup,original,focused}
}
async function fillContact(dialog,email){
  for(const [name,value] of Object.entries({tradingName:'Coastal trade',contactName:'Pat Client',email,phone:'604-555-0123',
    line1:'125 Water Street',line2:'Suite 400',city:'Vancouver',region:'BC',postalCode:'V6B 1A1',country:'CA',notes:'Internal Party note stays private'})){
    await dialog.locator('[name="'+name+'"]').fill(value)
  }
}
async function main(){
  for(let i=0;i<120;i++){
    if(server.exitCode!==null)throw Error('Isolated browser server exited')
    try{if((await fetch(origin+'/login')).ok)break}catch{}
    if(i===119)throw Error('Isolated browser server did not become ready')
    await new Promise(resolve=>setTimeout(resolve,250))
  }
  browser=await chromium.launch({headless:true})
  const context=await browser.newContext({viewport:{width:1440,height:1000}})
  await context.addInitScript('globalThis.__name = fn => fn')
  await context.addCookies([{name:'erp_session',value:fixture.token,url:origin,httpOnly:true,sameSite:'Lax'}])
  page=await context.newPage();page.on('pageerror',error=>report.consoleErrors.push(error.message));page.on('dialog',dialog=>dialog.accept())
  const [revenue]=await sql.unsafe("SELECT id::text,code FROM account WHERE entity_id=$1 AND account_type='revenue' AND is_active AND is_postable ORDER BY code LIMIT 1",[fixture.entityId])
  for(const width of [1440,900,390]){
    await page.setViewportSize({width,height:width<640?844:1000})
    await page.goto(origin+'/ledger/'+fixture.ledgerId+'/invoices/new',{waitUntil:'domcontentloaded'})
    await page.locator('[name="theirRef"]').fill('KEEP-'+width)
    await page.locator('[name="note"]').fill('Original invoice input survives Party creation '+width)
    await page.locator('[name="line.0.description"]').fill('Retained line '+width)
    await page.locator('[name="line.0.amount"]').fill('10.00')
    const account=page.getByRole('combobox',{name:'Account on line 1',exact:true})
    await account.fill(revenue.code)
    await page.locator('[data-picker="line.0.account"] [data-option="'+revenue.id+'"]').click()
    const picker=page.locator('[data-picker="partyId"] > input[role="combobox"]')
    const cancelled=await openFromPicker(picker,'New customer','Cancel customer '+width)
    const beforeCancel=await snapshot(picker)
    await cancelled.getByRole('button',{name:'Cancel',exact:true}).click()
    await expect(cancelled).not.toBeVisible()
    check(JSON.stringify(await snapshot(picker))===JSON.stringify(beforeCancel),'PW01-'+width+' cancel preserves every original field')
    await picker.fill('Existing customer')
    await page.locator('[data-picker="partyId"] [data-option="'+fixture.customerId+'"]').click()
    const before=await snapshot(picker)
    const [{n:invoiceCount}]=await sql.unsafe('SELECT count(*)::int AS n FROM invoice WHERE entity_id=$1',[fixture.entityId])
    const dialog=await openFromPicker(picker,'New customer')
    await dialog.locator('input[name="name"]').fill('Existing customer')
    await dialog.getByRole('button',{name:'Add',exact:true}).click()
    await expect(dialog.getByRole('alert')).toContainText('already on the list')
    check(withoutParty(await snapshot(picker))===withoutParty(before),'PW02-'+width+' duplicate refusal keeps invoice fields and stays in the dialog')
    const name='Created customer '+width+' '+runId
    await dialog.locator('input[name="name"]').fill(name)
    await dialog.locator('input[name="taxNumber"]').fill('123456789RT0001')
    const email='customer-'+width+'@example.test'
    await fillContact(dialog,email)
    await dialog.locator('[name="email"]').fill('invalid email')
    await dialog.getByRole('button',{name:'Add',exact:true}).click()
    check(await dialog.locator('[name="email"]').evaluate(input=>input.validity.typeMismatch)
      &&withoutParty(await snapshot(picker))===withoutParty(before),
      'PC01-'+width+' native email validation keeps both forms intact')
    await dialog.locator('[name="email"]').fill(email)
    await dialog.locator('[name="line1"]').fill('')
    await dialog.getByRole('button',{name:'Add',exact:true}).click()
    await expect(dialog.getByRole('alert')).toContainText('first line')
    check(await dialog.locator('[name="email"]').inputValue()===email
      &&await dialog.locator('[name="phone"]').inputValue()==='604-555-0123'
      &&withoutParty(await snapshot(picker))===withoutParty(before),
      'PC02-'+width+' address refusal preserves contact details and original invoice')
    await dialog.locator('[name="line1"]').fill('125 Water Street')
    const layout=await measure(dialog,picker);report.measurements.push(layout)
    check(!layout.popup.nestedForm&&!layout.popup.startInputs&&!layout.popup.outside.length&&!layout.popup.overlaps.length
      &&layout.popup.scrollWidth<=width&&layout.popup.svgs.every(svg=>svg.width>0&&svg.height>0&&!!svg.viewBox),
      'PW03-'+width+' separate floating form has visible controls without overflow or overlap')
    check(layout.focused.every(field=>field.visible&&!field.coveredByFooter),
      'PC03-'+width+' every field is reachable by focus and visible above the sticky action bar')
    await dialog.evaluate(root=>{root.scrollTop=0})
    await page.screenshot({path:evidence+'/party-dialog-'+width+'.png',fullPage:true})
    await dialog.getByRole('button',{name:'Add',exact:true}).click()
    await expect(dialog).not.toBeVisible({timeout:30000})
    await expect(picker).toHaveValue(name)
    const id=await page.locator('input[type="hidden"][name="partyId"]').inputValue()
    const [created]=await sql.unsafe('SELECT p.name,p.tax_number,r.role,r.held_from::text FROM party p JOIN party_role r ON r.party_id=p.id WHERE p.id=$1 AND r.entity_id=$2',[id,fixture.entityId])
    check(created?.name===name&&created.tax_number==='123456789RT0001'&&created.role==='customer'&&created.held_from===null,
      'PW04-'+width+' real Server Action creates the party without a start date and selects its id')
    const [details]=await sql.unsafe('SELECT p.trading_name,p.notes,c.name AS contact,c.email,c.phone,c.is_primary,a.line1,a.line2,a.city,a.region,a.postal_code,a.country FROM party p JOIN party_contact c ON c.party_id=p.id JOIN party_address a ON a.party_id=p.id AND a.purpose=$2 WHERE p.id=$1',[id,'mailing'])
    check(details?.trading_name==='Coastal trade'&&details.notes==='Internal Party note stays private'&&details.contact==='Pat Client'
      &&details.email===email&&details.phone==='604-555-0123'&&details.is_primary&&details.line1==='125 Water Street'
      &&details.line2==='Suite 400'&&details.city==='Vancouver'&&details.region==='BC'&&details.postal_code==='V6B 1A1'&&details.country==='CA',
      'PC04-'+width+' the actual create action stores all contact and address fields')
    const [{n:afterChild}]=await sql.unsafe('SELECT count(*)::int AS n FROM invoice WHERE entity_id=$1',[fixture.entityId])
    check(afterChild===invoiceCount&&withoutParty(await snapshot(picker))===withoutParty(before),
      'PW05-'+width+' adding the party never submits or resets the valid original invoice')
    await page.locator('[name="issuedOn"]').fill('2026-01-15')
    await page.getByRole('button',{name:'Save to the books',exact:true}).click()
    await expect(page.getByRole('status').filter({hasText:/Saved|Added|INV-/}).first()).toBeVisible({timeout:30000})
    const [invoice]=await sql.unsafe('SELECT i.id::text,i.issued_on::text,i.party_id::text,e.status FROM invoice i JOIN journal_entry e ON e.id=i.entry_id WHERE i.party_id=$1 ORDER BY i.created_at DESC LIMIT 1',[id])
    check(invoice?.issued_on==='2026-01-15'&&invoice.party_id===id&&invoice.status==='posted',
      'PW06-'+width+' the original form posts a historical invoice for the newly created party')
    const response=await page.request.get(origin+'/ledger/'+fixture.ledgerId+'/invoices/'+invoice.id+'/pdf')
    const pdf=await response.body(),text=execFileSync('pdftotext',['-layout','-','-'],{input:pdf,encoding:'utf8'})
    check(response.status()===200&&['125 Water Street','Suite 400','Vancouver BC V6B 1A1','Attn: Pat Client',email,'Phone: 604-555-0123','10.00'].every(value=>text.includes(value))
      &&!text.includes('Internal Party note stays private'),
      'PC05-'+width+' the real invoice PDF displays saved customer details and excludes internal notes')
    if(width===1440){
      writeFileSync(evidence+'/after-invoice.pdf',pdf)
      await page.goto(origin+'/ledger/'+fixture.ledgerId+'/parties/new?copy='+id,{waitUntil:'domcontentloaded'})
      await expect(page.locator('[name="name"]')).toHaveValue(name+' (copy)')
      for(const [field,value] of Object.entries({contactName:'Pat Client',email,phone:'604-555-0123',line1:'125 Water Street',line2:'Suite 400',city:'Vancouver',region:'BC',postalCode:'V6B 1A1',country:'CA'})){
        await expect(page.locator('[name="'+field+'"]')).toHaveValue(value)
      }
      check(await page.locator('[name="taxNumber"]').inputValue()==='',
        'PC06 copying a Party prefills contact and mailing details while retaining the existing blank tax-number rule')
    }
  }
  const before=JSON.parse(readFileSync(evidence+'/before-layout.json','utf8'))
  const original=report.measurements.find(x=>x.popup.viewport===1440).original
  const differences=before.invoice.controls.filter(x=>x.name||x.label).flatMap(old=>{
    const next=original.controls.find(x=>x.name===old.name&&x.label===old.label)
    if(!next)return[{name:old.name,label:old.label,missing:true}]
    const relative=(x,f)=>[x.x-f.x,x.y-f.y,x.width,x.height]
    const a=relative(old,before.invoice.form),b=relative(next,original.form)
    return a.some((v,i)=>Math.abs(v-b[i])>1)?[{name:old.name,label:old.label,before:a,after:b}]:[]
  })
  report.originalFormComparison={differences}
  check(!differences.length,'PW07 original invoice controls preserve their measured dimensions and relative positions')
  await page.setViewportSize({width:1440,height:1000})
  await page.goto(origin+'/ledger/'+fixture.ledgerId+'/parties/new',{waitUntil:'domcontentloaded'})
  await expect(page.locator('input[name="name"]')).toBeVisible()
  check(await page.locator('[name="heldFrom"]').count()===0,'PW08 the standalone Party form also has no start date')
  await page.goto(origin+'/ledger/'+fixture.ledgerId+'/invoices',{waitUntil:'domcontentloaded'})
  await page.locator('[data-add-trigger]').first().click()
  await page.getByRole('link',{name:'New invoice',exact:true}).click()
  await expect(page.locator('.overlay-panel')).toBeVisible()
  const picker=page.locator('.overlay-panel [data-picker="partyId"] > input[role="combobox"]')
  await page.locator('.overlay-panel [name="note"]').fill('Retained inside routed overlay')
  const dialog=await openFromPicker(picker,'New customer','Overlay cancelled customer')
  await dialog.press('Escape')
  await expect(dialog).not.toBeVisible()
  check(await page.locator('.overlay-panel').isVisible()&&await page.locator('.overlay-panel [name="note"]').inputValue()==='Retained inside routed overlay',
    'PW09 Escape closes only the nested Party dialog and preserves the routed invoice overlay')
  await page.goto(origin+'/ledger/'+fixture.ledgerId+'/projects',{waitUntil:'domcontentloaded'})
  await page.getByRole('button',{name:'New project',exact:true}).click()
  const project=page.getByRole('dialog',{name:'New project',exact:true})
  await expect(project).toBeVisible()
  await project.locator('[name="name"]').fill('Unsubmitted project stays here')
  await project.locator('[name="code"]').fill('UNSUBMITTED')
  const customer=project.getByRole('combobox',{name:'Customer',exact:true})
  const projectBefore=await snapshot(customer)
  const projectCustomer='Customer inside native project dialog '+runId
  const nested=await openFromPicker(customer,'New customer',projectCustomer)
  await fillContact(nested,'project@example.test')
  await nested.getByRole('button',{name:'Add',exact:true}).click()
  await expect(nested).not.toBeVisible({timeout:30000})
  await expect(customer).toHaveValue(projectCustomer)
  const [{n:projects}]=await sql.unsafe('SELECT count(*)::int AS n FROM project WHERE entity_id=$1',[fixture.entityId])
  check(projects===0&&await project.isVisible()&&withoutParty(await snapshot(customer),'customerPartyId')===withoutParty(projectBefore,'customerPartyId'),
    'PW10 creation inside a native floating project keeps its fields and never submits the project')
  const projectPartyId=await project.locator('input[type="hidden"][name="customerPartyId"]').inputValue()
  const [projectDetails]=await sql.unsafe('SELECT c.email,c.phone,a.line1 FROM party_contact c JOIN party_address a ON a.party_id=c.party_id WHERE c.party_id=$1',[projectPartyId])
  check(projectDetails?.email==='project@example.test'&&projectDetails.phone==='604-555-0123'&&projectDetails.line1==='125 Water Street',
    'PC07 nested native project creation also saves the full Party contact')
  check(!report.consoleErrors.length,'PW11 no browser runtime errors')
  report.passed=true
}
try{await main()}catch(error){report.error=error instanceof Error?error.message:String(error);if(page)await page.screenshot({path:evidence+'/browser-failure.png',fullPage:true}).catch(()=>{});console.error(report.error);process.exitCode=1}
finally{
  writeFileSync(evidence+'/browser-result.json',JSON.stringify(report,null,2)+'\n')
  await browser?.close();await sql.end()
  server.kill('SIGTERM');await new Promise(resolve=>{if(server.exitCode!==null)resolve();else{server.once('exit',resolve);setTimeout(()=>{server.kill('SIGKILL');resolve()},3000).unref()}})
  await new Promise(resolve=>log.end(resolve))
}
