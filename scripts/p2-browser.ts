import { chromium,expect,type Page } from '@playwright/test'
import { mkdtemp,cp,readFile,writeFile,constants } from 'node:fs/promises'
import { spawn,spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { PDFDocument } from 'pdf-lib'
import dotenv from 'dotenv'
import postgres from 'postgres'
import { randomUUID,createHash } from 'node:crypto'

async function main() {
  const phase=process.argv.includes('--capture-current-layout')?'current-layout':process.argv.includes('--baseline')?'baseline':process.argv.includes('--initial')?'initial':'final',root=process.cwd(),evidence=join(root,'docs/evidence/p2')
  const sourceRoot=phase==='baseline'?process.env.P2_BASELINE_SOURCE:root
  if(!sourceRoot)throw Error('A retained pre-link FigTree build source is required for baseline replay')
  if(phase==='baseline') {
    const sources=['src/app/ledger/[ledgerId]/entries/[entryId]/EntryBody.tsx','src/app/ledger/[ledgerId]/invoices/[invoiceId]/DetailBody.tsx','src/app/ledger/[ledgerId]/parties/[partyId]/PartyBody.tsx'],hashes=[]
    for(const file of sources){const bytes=await readFile(join(sourceRoot,file));if(bytes.includes(Buffer.from('SourcePapers'))||bytes.includes(Buffer.from('/automation/mail/new')))throw Error('Baseline source already contains target-link additions');hashes.push({file,sha256:createHash('sha256').update(bytes).digest('hex')})}
    await writeFile(join(evidence,'layout-baseline-source.json'),JSON.stringify({at:new Date().toISOString(),source:'Retained FigTree browser build created before target-link additions; replayed after detecting skeleton measurements',hashes},null,2)+'\n')
  }
  const config=process.env.TEST_DATABASE_URL?process.env:dotenv.parse(await readFile('/tmp/figtree-p2-test.env'))
  const name=config.TEST_DATABASE_URL?new URL(config.TEST_DATABASE_URL).pathname.slice(1):''
  if(!/^[a-z][a-z0-9_]*_test$/.test(name)||config.TEST_DATABASE_CONFIRMATION!==name||!config.DATABASE_URL||new URL(config.DATABASE_URL).pathname.slice(1)===name)throw Error('Browser requires confirmed test and distinct app databases')
  if(!process.env.TEST_DATABASE_URL){const proof=JSON.parse(await readFile(join(evidence,'isolation.json'),'utf8'));if(name!==proof.testDatabase)throw Error('Browser isolation mismatch')}
  const scratch=await mkdtemp(join(tmpdir(),'figtree-p2-browser-')),fixture=join(scratch,'fixture.json')
  const env:NodeJS.ProcessEnv={...process.env,...config,P2_BROWSER_FIXTURE:fixture,P2_CAPTURE_DIR:evidence,NODE_OPTIONS:'--conditions=react-server'}
  const seed=spawnSync('npm',['run','db:verify-p2'],{env,encoding:'utf8',maxBuffer:16e6})
  await writeFile(join(evidence,`browser-${phase}-seed.log`),seed.stdout+seed.stderr)
  if(seed.status!==0)throw Error('P2 browser seed suite failed')
  const f=JSON.parse(await readFile(fixture,'utf8'))
  for(const part of ['src','public','package.json','tsconfig.json','next.config.ts','postcss.config.mjs','next-env.d.ts','node_modules'])await cp(join(part==='node_modules'?root:sourceRoot,part),join(scratch,part),{recursive:true,mode:constants.COPYFILE_FICLONE})
  const runtime:NodeJS.ProcessEnv={...env,DATABASE_URL:config.TEST_DATABASE_URL,ATTACHMENTS_DIR:f.attachmentsRoot,NODE_OPTIONS:'',NODE_ENV:'production',AUTOMATION_ENABLED:'true'}
  const bin=join(scratch,'node_modules/next/dist/bin/next'),built=spawnSync('node',[bin,'build'],{cwd:scratch,env:runtime,encoding:'utf8',maxBuffer:16e6})
  await writeFile(join(evidence,`browser-${phase}-build.log`),built.stdout+built.stderr)
  if(built.status!==0)throw Error('P2 production browser build failed')
  const socket=createServer();await new Promise<void>(r=>socket.listen(0,'127.0.0.1',r));const port=(socket.address() as {port:number}).port;await new Promise<void>(r=>socket.close(()=>r()))
  const server=spawn('node',[bin,'start','--hostname','127.0.0.1','--port',String(port)],{cwd:scratch,env:runtime,stdio:['ignore','pipe','pipe']})
  let serverLog='';server.stdout.on('data',b=>serverLog+=String(b));server.stderr.on('data',b=>serverLog+=String(b))
  const browser=await chromium.launch({headless:true,channel:'chromium'}).catch(async error=>{
    server.kill('SIGTERM');await writeFile(join(evidence,`browser-${phase}-server.log`),serverLog);throw error
  }),context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),base=`http://127.0.0.1:${port}`
  const database=postgres(config.TEST_DATABASE_URL!),measurements:unknown[]=[],checks:string[]=[]
  const pass=(label:string)=>{checks.push(label);console.log('PASS '+label)}
  async function waitForPdf(relativeFile:string) {
    await expect.poll(async()=>{
      for(const frame of page.frames().filter(f=>f.url().includes(relativeFile))) {
        const ready=await frame.evaluate(()=>!!document.querySelector('embed[type="application/x-google-chrome-pdf"]')&&(document.getElementById('sizer')?.clientHeight??0)>0).catch(()=>false)
        if(ready)return true
      }
      return false
    },{timeout:60000}).toBe(true)
  }
  async function measure(page:Page,label:string) {
    await page.locator('main h1').first().waitFor({state:'visible',timeout:60000})
    // Measure the acquired editor, not its asynchronous checking placeholder.
    // This also guarantees the following Stop editing action can release it.
    const proofs=page.locator('main [data-edit-protection] input[name="editToken"]')
    for(let i=0;i<await proofs.count();i++)await expect(proofs.nth(i)).not.toHaveValue('',{timeout:60000})
    await page.evaluate(async()=>{await document.fonts.ready})
    const result=await page.evaluate(()=>{
      const controls=Array.from(document.querySelectorAll('main button,main input:not([type="hidden"]),main select,main textarea,main a[href]')).filter(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'})
      const elements=controls.map(e=>{const r=e.getBoundingClientRect(),anchor=(e.closest('form')??e.closest('section')??e.closest('main'))!.getBoundingClientRect();return {tag:e.tagName,name:e.getAttribute('name'),text:e.textContent?.slice(0,80),x:r.x,y:r.y,width:r.width,height:r.height,anchorX:anchor.x,anchorY:anchor.y}})
      const overlaps=[]
      for(let i=0;i<controls.length;i++)for(let j=i+1;j<controls.length;j++){
        if(controls[i].contains(controls[j])||controls[j].contains(controls[i]))continue
        const a=controls[i].getBoundingClientRect(),b=controls[j].getBoundingClientRect()
        if(Math.min(a.right,b.right)-Math.max(a.left,b.left)>1.5&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1.5)overlaps.push([i,j])
      }
      return {elements,overlaps,documentOverflow:document.documentElement.scrollWidth>innerWidth+1,invalidSvg:Array.from(document.querySelectorAll('main svg')).filter(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'}).filter(e=>!e.getAttribute('viewBox')).length}
    })
    measurements.push({label,width:page.viewportSize()!.width,...result})
    await writeFile(join(evidence,`browser-${phase}-measurements.json`),JSON.stringify(measurements,null,2)+'\n')
    await page.screenshot({path:join(evidence,`browser-${phase}-${label}-${page.viewportSize()!.width}.png`),fullPage:true})
    if(result.elements.length<4||result.overlaps.length||result.documentOverflow||result.invalidSvg)throw Error('Computed layout failure '+label+': '+JSON.stringify({controls:result.elements.length,overlaps:result.overlaps,overflow:result.documentOverflow,svg:result.invalidSvg}))
    return result
  }
  try {
    for(let n=0;n<120;n++){try{if((await fetch(base+'/login')).ok)break}catch{}if(n===119)throw Error('Browser server readiness timeout');await new Promise(r=>setTimeout(r,500))}
    await page.goto(base+'/login');await page.getByLabel('Email',{exact:true}).fill(f.email);await page.getByLabel('Password',{exact:true}).fill(f.password);await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.waitForURL(u=>!u.pathname.startsWith('/login'),{timeout:60000})
    for(const width of [1440,900]) {
      await page.setViewportSize({width,height:1000})
      for(const [label,path] of [['invoice',`invoices/${f.invoiceId}`],['entry',`entries/${f.journalId}`],['customer',`parties/${f.customerId}`],['inbox','readings/inbox'],['recurring','automation/recurring'],['mail','income/email'],['reminders','automation/reminders'],['jobs','automation/jobs']]) {
        await page.goto(base+`/ledger/${f.ledgerId}/`+path);await expect(page.locator('main').first()).toBeVisible();await measure(page,label)
        // Party and reminder are separate editors; release each actual owner.
        for(const editor of await page.locator('main [data-edit-protection]').all()){
          const stop=editor.getByRole('button',{name:'Stop editing',exact:true})
          if(await stop.count()){await stop.click();await expect(editor).toContainText('Editing stopped',{timeout:60000})}
        }
      }
    }
    pass('P2UI01 real workspace layout at 1440 and 900: controls do not overlap or overflow')
    if(phase!=='final'){
      if(phase==='current-layout'){
        const files=['src/lib/ui.ts','src/app/globals.css','src/components/ApplicationFrame.tsx','src/components/SettingsFrame.tsx','src/app/ledger/[ledgerId]/entries/[entryId]/EntryBody.tsx','src/app/ledger/[ledgerId]/invoices/[invoiceId]/DetailBody.tsx','src/app/ledger/[ledgerId]/parties/[partyId]/PartyBody.tsx']
        const hashes=await Promise.all(files.map(async file=>({file,sha256:createHash('sha256').update(await readFile(join(sourceRoot,file))).digest('hex')})))
        await writeFile(join(evidence,'layout-current-source.json'),JSON.stringify({at:new Date().toISOString(),reason:'Accepted application-shell redesign supersedes the pre-redesign P2 geometry; captured real loaded controls, without running financial workflow assertions',hashes},null,2)+'\n')
        pass('P2 current-layout baseline captured from real loaded workspaces at both widths');return
      }
      pass(phase==='initial'?'P2UI02 target-document DOM recorded before adding source/email links':'P2UI02 loaded pre-link source replay measured for comparison; replay timestamp is after editing');return}
    // Frozen real baseline for the accepted shell redesign. Historical P2
    // captures remain evidence; missing current geometry fails rather than skips.
    // Dynamic upstream status text can wrap differently for synthetic UUIDs/ports;
    // compare within the owning form/section, retaining absolute overlap checks.
    const baseline=join(evidence,'browser-current-layout-measurements.json')
    {
      type Element={tag:string;name:string|null;text:string|null;x:number;y:number;width:number;height:number;anchorX:number;anchorY:number}
      type Measurement={label:string;width:number;elements:Element[]}
      const before=JSON.parse(await readFile(baseline,'utf8')) as Measurement[],after=measurements as Measurement[],comparisons=[]
      for(const b of before.filter(b=>['invoice','entry','customer'].includes(b.label)&&b.elements.length>=4)) {
        const a=after.find(a=>a.label===b.label&&a.width===b.width)!,used=new Set<number>(),key=(e:Element)=>JSON.stringify([e.tag,e.name,e.text])
        const changes=[]
        for(const old of b.elements){const n=a.elements.findIndex((e,i)=>!used.has(i)&&key(e)===key(old));if(n<0)continue;used.add(n);const current=a.elements[n];if(![old,current].every(e=>[e.x,e.y,e.width,e.height,e.anchorX,e.anchorY].every(Number.isFinite)))throw Error('Layout baseline contains missing/nonfinite geometry');changes.push({key:key(old),dx:(current.x-current.anchorX)-(old.x-old.anchorX),dy:(current.y-current.anchorY)-(old.y-old.anchorY),dw:current.width-old.width,dh:current.height-old.height})}
        comparisons.push({label:b.label,width:b.width,matched:changes.length,changes})
      }
      await writeFile(join(evidence,'layout-comparison.json'),JSON.stringify(comparisons,null,2)+'\n')
      // Name what moved: CI keeps no evidence files, so a bare sentence there left nothing to inspect (2026-10-20).
      const moved=comparisons.flatMap(c=>c.changes.filter(d=>Math.abs(d.dx)>2||Math.abs(d.dy)>2||Math.abs(d.dw)>2||Math.abs(d.dh)>2).map(d=>`${c.label}@${c.width} ${d.key} dx=${d.dx} dy=${d.dy} dw=${d.dw} dh=${d.dh}`))
      if(!comparisons.length||comparisons.some(c=>c.matched<4)||moved.length)throw Error('Existing target controls moved; inspect actual before/after comparison'+(moved.length?`: ${moved.join('; ')}`:`: ${comparisons.map(c=>`${c.label}@${c.width} matched ${c.matched}`).join(', ')}`))
      pass('P2UI07 measured before/after: stable document controls retain size and local form geometry within 2px')
    }
    await page.setViewportSize({width:1440,height:1000});await page.goto(base+`/ledger/${f.ledgerId}/readings/inbox`)
    const pdf=await PDFDocument.create();pdf.addPage().drawText('P2 real browser receipt '+randomUUID(),{x:50,y:730,size:14});const upload=join(scratch,'browser-receipt.pdf');await writeFile(upload,await pdf.save())
    await page.locator('input[name="file"]').setInputFiles(upload);await page.getByRole('button',{name:'Upload receipt',exact:true}).click();await page.waitForURL(u=>/\/readings\/inbox\/[0-9a-f-]+$/.test(u.pathname),{timeout:60000})
    const inboxId=page.url().split('/').at(-1)!
    await expect(page.locator('input[name="editToken"]')).not.toHaveValue('',{timeout:60000})
    await waitForPdf(`/automation/inbox/${inboxId}/file`)
    await measure(page,'review-original')
    await page.setViewportSize({width:900,height:1000});await measure(page,'review-original-narrow');await page.setViewportSize({width:1440,height:1000})
    await writeFile(join(evidence,'original-preview-frames.json'),JSON.stringify(page.frames().map(f=>f.url()),null,2)+'\n')
    const sibling=await page.context().newPage();await sibling.goto(page.url());await expect(sibling.locator('[data-edit-protection]')).toContainText('is editing',{timeout:60000});await sibling.close();pass('P2UI08 same-user receipt tabs have distinct protected leases')
    await page.getByRole('combobox',{name:'Supplier or customer',exact:true}).click();await page.getByRole('option',{name:'P2 supplier',exact:true}).click();await page.getByRole('combobox',{name:'Receivable or payable account',exact:true}).click();await page.getByRole('option',{name:/2000.*Payables/}).click();await page.locator('input[name="dueOn"]').fill('2026-11-08')
    await page.locator('select[name="paid"]').selectOption('no');await page.getByRole('combobox',{name:'Account on line 1',exact:true}).click();await page.getByRole('option',{name:/5000.*Expenses/}).click()
    await page.locator('input[name="line.0.amount"]').fill('100.00');await page.locator('input[name="total"]').fill('99.99');await page.getByRole('button',{name:'Create reviewed draft',exact:true}).click()
    await expect(page.locator('main form [role="alert"]').first()).toContainText('do not equal',{timeout:60000});await expect(page.locator('input[name="total"]')).toHaveValue('99.99');await expect(page.locator('input[name="line.0.amount"]')).toHaveValue('100.00');pass('P2UI03 actual conversion refusal preserves reviewed fields')
    await page.locator('input[name="total"]').fill('100.00');await page.getByRole('button',{name:'Create reviewed draft',exact:true}).click();await expect(page.getByText('This source is finished.')).toBeVisible({timeout:60000})
    const [saved]=await database`SELECT n.target_invoice_id,i.status,i.entry_id FROM inbox_item n JOIN invoice i ON i.id=n.target_invoice_id WHERE n.id=${inboxId}`
    if(!saved||saved.status!=='draft'||saved.entry_id!==null)throw Error('Browser conversion did not create a real draft only')
    pass('P2UI04 actual Server Action creates one traceable draft without GL')
    await measure(page,'review-converted');await page.getByRole('link',{name:'Recorded document',exact:true}).click();await page.waitForURL(u=>u.pathname.includes(saved.target_invoice_id))
    await expect(page.getByRole('link',{name:/browser-receipt.pdf/})).toBeVisible();pass('P2UI05 draft document offers its original source')
    const response=await page.request.get(base+`/ledger/${f.ledgerId}/invoices/${saved.target_invoice_id}/source/${inboxId}`)
    if(response.status()!==200||!(await response.body()).equals(Buffer.from(await readFile(upload))))throw Error('Target source download lost original bytes')
    pass('P2UI06 actual authorized target download retains exact uploaded bytes')
    await page.goto(base+`/settings/services?ledger=${f.ledgerId}&section=execution`);await page.locator('input[name="enabled"]').check();await page.locator('input[name="mailEnabled"]').check();await page.getByRole('button',{name:'Save execution settings',exact:true}).click();await expect(page.getByRole('status')).toContainText('Saved',{timeout:60000})
    await page.goto(base+`/ledger/${f.ledgerId}/income/email/new?invoice=${f.invoiceId}`);await page.locator('input[name="subject"]').fill('Real P2 browser approved invoice');await page.getByRole('button',{name:'Preview email',exact:true}).click();await page.waitForURL(u=>/\/income\/email\/[0-9a-f-]+$/.test(u.pathname),{timeout:60000})
    const messageId=page.url().split('/').at(-1)!,pdfResponse=await page.request.get(base+`/ledger/${f.ledgerId}/income/email/${messageId}/file`)
    if(pdfResponse.status()!==200||(await pdfResponse.body()).subarray(0,5).toString()!=='%PDF-')throw Error('Approved email PDF was not generated')
    await waitForPdf(`/income/email/${messageId}/file`);pass('P2UI11 original and approved email have loaded actual PDF document dimensions; screenshots require visual review')
    await measure(page,'email-preview');await page.getByRole('button',{name:'Send email',exact:true}).click();await expect(page.getByText('queued',{exact:true})).toBeVisible({timeout:60000})
    const [authorization]=await database`SELECT m.status,(SELECT count(*)::int FROM background_job WHERE email_message_id=m.id) AS jobs FROM email_message m WHERE id=${messageId}`
    if(authorization.status!=='queued'||authorization.jobs!==1)throw Error('Browser send authorization did not create one durable job')
    pass('P2UI09 actual preview PDF and explicit browser authorization create one queued send; no worker was invoked')
    await page.goto(base+`/ledger/${f.ledgerId}/automation/recurring`);await page.locator('input[name="title"]').fill('Browser one recurring journal');await page.locator('select[name="documentType"]').selectOption('entry');await page.locator('select[name="sourceId"]').selectOption(f.journalId);await page.locator('select[name="frequency"]').selectOption('weekly');await page.locator('input[name="maxOccurrences"]').fill('1');await page.locator('input[name="active"]').check();await page.getByRole('button',{name:'Create template',exact:true}).click();await page.waitForURL(u=>/\/automation\/recurring\/[0-9a-f-]+$/.test(u.pathname),{timeout:60000})
    const templateId=page.url().split('/').at(-1)!;await expect(page.locator('input[name="editToken"]')).not.toHaveValue('',{timeout:60000});await measure(page,'recurring-detail')
    await page.getByRole('button',{name:/Generate next saved draft/}).click();await expect(page.getByRole('status').filter({hasText:'Saved. Review the current status and recorded target.'})).toBeVisible({timeout:60000})
    const [occurrence]=await database`SELECT count(*)::int AS n FROM recurring_occurrence o JOIN journal_entry e ON e.id=o.target_entry_id WHERE o.template_id=${templateId} AND e.status='draft'`
    if(occurrence.n!==1)throw Error('Browser recurring generation did not create one real draft')
    pass('P2UI10 actual protected recurring form generates one manual draft')
    const limitedContext=await browser.newContext(),limitedPage=await limitedContext.newPage()
    await limitedPage.goto(base+'/login');await limitedPage.getByLabel('Email',{exact:true}).fill('p2-limited@example.test');await limitedPage.getByLabel('Password',{exact:true}).fill(f.password);await limitedPage.getByRole('button',{name:'Sign in',exact:true}).click();await limitedPage.waitForURL(u=>!u.pathname.startsWith('/login'))
    const forbiddenSource=await limitedPage.request.get(base+`/ledger/${f.ledgerId}/invoices/${saved.target_invoice_id}/source/${inboxId}`)
    if(forbiddenSource.status()!==403)throw Error('Automation-only browser user obtained a financial source')
    await limitedPage.goto(base+`/ledger/${f.ledgerId}/income/email`);await limitedPage.waitForURL(u=>u.pathname==='/no-access')
    pass('P2UI12 actual limited-user page and source route refuse missing invoice authorization')
    await limitedContext.close()
  } finally {
    await writeFile(join(evidence,`browser-${phase}-results.json`),JSON.stringify({at:new Date().toISOString(),phase,checks},null,2)+'\n')
    await writeFile(join(evidence,`browser-${phase}-server.log`),serverLog)
    await browser.close();server.kill('SIGTERM');await database.end()
  }
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e instanceof Error?e.message:String(e));process.exit(1)})
