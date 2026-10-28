/** Browser + real server + confirmed disposable PostgreSQL. Nothing mocked. */
import './dotenv'
import {chromium,expect,type Page} from '@playwright/test'
import {spawn,spawnSync} from 'node:child_process'
import {cp,mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises'
import {constants} from 'node:fs'
import {randomBytes} from 'node:crypto'
import {createServer} from 'node:net'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import postgres from 'postgres'
import {decryptMfa,totp} from '../src/lib/totp'
async function main(){
  const test=process.env.TEST_DATABASE_URL!,name=new URL(test).pathname.slice(1)
  if(process.env.TEST_DATABASE_CONFIRMATION!==name || !/^[a-z][a-z0-9_]*_test$/.test(name))throw Error('Unconfirmed browser database')
  const root=process.cwd(),scratch=await mkdtemp(join(tmpdir(),'figtree-p1-browser-')),evidence=join(root,process.env.P1_EVIDENCE_DIR??'docs/evidence/p1')
  await mkdir(evidence,{recursive:true})
  const key=randomBytes(32).toString('base64'),fixtureFile=join(scratch,'fixture.json')
  const env={...process.env,AUTH_MFA_KEY:key,P1_BROWSER_FIXTURE:fixtureFile}
  const seed=spawnSync('npm',['run','db:verify-p1'],{cwd:root,env,encoding:'utf8',maxBuffer:8e6})
  await writeFile(join(evidence,'browser-seed.log'),seed.stdout+seed.stderr)
  if(seed.status!==0){await rm(scratch,{recursive:true,force:true});throw Error('Browser seed verification failed')}
  const f=JSON.parse(await readFile(fixtureFile,'utf8'))
  for(const file of ['src','public','package.json','tsconfig.json','next.config.ts','postcss.config.mjs','next-env.d.ts'])await cp(join(root,file),join(scratch,file),{recursive:true})
  // Turbopack rejects a node_modules symlink outside its filesystem root.
  // Copy the installed, locked dependencies; do not change the app compiler.
  await cp(join(root,'node_modules'),join(scratch,'node_modules'),{recursive:true,mode:constants.COPYFILE_FICLONE})
  const runtimeEnv:NodeJS.ProcessEnv={...env,DATABASE_URL:test,APP_DATABASE_URL:process.env.DATABASE_URL,NODE_OPTIONS:'',NODE_ENV:'production'}
  const nextBin=join(scratch,'node_modules/next/dist/bin/next')
  const built=spawnSync('node',[nextBin,'build'],{cwd:scratch,env:runtimeEnv,encoding:'utf8',maxBuffer:16e6})
  await writeFile(join(evidence,'browser-build.log'),built.stdout+built.stderr)
  if(built.status!==0){await rm(scratch,{recursive:true,force:true});throw Error('Real browser production build failed')}
  const socket=createServer();await new Promise<void>(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=(socket.address() as {port:number}).port;await new Promise<void>(resolve=>socket.close(()=>resolve()))
  let server=spawn('node',[nextBin,'start','--hostname','127.0.0.1','--port',String(port)],{cwd:scratch,env:runtimeEnv,stdio:['ignore','pipe','pipe']})
  let serverLog='';server.stdout.on('data',b=>{serverLog+=String(b)});server.stderr.on('data',b=>{serverLog+=String(b)})
  const database=postgres(test,{max:2}),browser=await chromium.launch({headless:true}),base=`http://127.0.0.1:${port}`
  const checks:string[]=[],measurements:unknown[]=[]
  const pass=(label:string)=>{checks.push(label);console.log('PASS '+label)}
  const login=async(page:Page,email:string,factor?:string)=>{
    await page.goto(base+'/login',{timeout:120000});await page.getByLabel('Email',{exact:true}).fill(email);await page.getByLabel('Password',{exact:true}).fill(f.password)
    if(factor)await page.locator('input[name="factor"]').fill(factor)
    await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.waitForURL(url=>!url.pathname.startsWith('/login'),{timeout:60000})
  }
  const measure=async(page:Page,label:string)=>{
    const result=await page.evaluate(()=>Array.from(document.querySelectorAll('h1, [data-edit-protection], form button, form input:not([type="hidden"]), form pre')).map(e=>{const r=e.getBoundingClientRect();return {tag:e.tagName,text:e.tagName==='BUTTON'?e.textContent:'',x:r.x,y:r.y,width:r.width,height:r.height,visible:r.width>0&&r.height>0}}))
    measurements.push({label,viewport:page.viewportSize(),elements:result});await writeFile(join(evidence,'browser-measurements.json'),JSON.stringify(measurements,null,2)+'\n');return result
  }
  try{
    for(let n=0;n<120;n++){if(server.exitCode!==null)throw Error('Browser server exited');try{if((await fetch(base+'/login')).ok)break}catch{}if(n===119)throw Error('Browser server readiness timeout');await new Promise(resolve=>setTimeout(resolve,500))}
    const a=await browser.newContext({viewport:{width:1440,height:1000}}),b=await browser.newContext({viewport:{width:1440,height:1000}})
    const p=await a.newPage(),q=await b.newPage();await login(p,f.email);await login(q,f.peerEmail)
    const invoice=`/ledger/${f.ledgerId}/invoices/${f.invoiceId}/edit`
    await p.goto(base+invoice);await expect(p.locator('input[name="editToken"]')).not.toHaveValue('',{timeout:60000})
    await p.locator('[name="note"]').fill('Unsaved owner browser input')
    await measure(p,'invoice-before-conflict')
    await q.goto(base+invoice);await expect(q.locator('[data-edit-protection]')).toContainText('is editing',{timeout:60000});pass('B01 second browser receives lease refusal')
    await q.getByRole('button',{name:'Administrator takeover',exact:true}).click();await expect(q.locator('input[name="editToken"]')).not.toHaveValue('',{timeout:60000})
    await p.getByRole('button',{name:'Save changes',exact:true}).click();await expect(p.locator('form [role="alert"]')).toContainText(/holds this document|lease expired/,{timeout:60000});await expect(p.locator('[name="note"]')).toHaveValue('Unsaved owner browser input');pass('B02 takeover rejects stale holder and preserves unsaved input')
    const actionRequest=q.waitForRequest(req=>req.method()==='POST' && !!req.headers()['next-action'] && !!req.postData()?.includes('Peer browser committed note'))
    await q.locator('[name="note"]').fill('Peer browser committed note');await q.getByRole('button',{name:'Save changes',exact:true}).click();await expect(q.getByRole('status').filter({hasText:/updated|saved|changed/i}).first()).toBeVisible({timeout:60000})
    const posted=await actionRequest
    const [saved]=await database`SELECT note FROM invoice WHERE id=${f.invoiceId}`;if(saved.note!=='Peer browser committed note')throw Error('Browser save did not reach accounting owner');pass('B03 new holder commits through actual server action')
    const pdfPath=`/ledger/${f.ledgerId}/invoices/${f.invoiceId}/pdf`
    const preview=await a.request.get(base+`/ledger/${f.ledgerId}/invoices/${f.invoiceId}/print`,{maxRedirects:0})
    if(preview.status()!==307||preview.headers().location!==pdfPath)throw Error('Legacy invoice preview did not redirect before rendering the layout')
    const pdf=await a.request.get(base+pdfPath)
    if(!pdf.ok()||!pdf.headers()['content-type']?.startsWith('application/pdf')||(await pdf.body()).subarray(0,5).toString()!=='%PDF-')throw Error('Invoice preview did not reach a valid authenticated PDF')
    pass('B03a legacy invoice print bookmark redirects directly to a valid authenticated PDF')
    await measure(p,'invoice-after-conflict');await p.screenshot({path:join(evidence,'invoice-conflict.png'),fullPage:true})
    await q.locator('[name="note"]').fill('Missing version must stay unsaved');await q.locator('input[name="expectedVersion"]').evaluate(e=>e.remove());await q.getByRole('button',{name:'Save changes',exact:true}).click();await expect(q.locator('form [role="alert"]')).toContainText('version is required',{timeout:60000});await expect(q.locator('[name="note"]')).toHaveValue('Missing version must stay unsaved');pass('B04 tampered missing proof rejected without clearing input')
    const [unchanged]=await database`SELECT note FROM invoice WHERE id=${f.invoiceId}`;if(unchanged.note!==saved.note)throw Error('Missing proof changed database')
    const tab=await a.newPage();await tab.goto(base+`/ledger/${f.ledgerId}/bills/${f.billId}/edit`);await expect(tab.locator('input[name="editToken"]')).not.toHaveValue('',{timeout:60000});pass('B05 bill editor obtains distinct edit proof')
    const sibling=await a.newPage();await sibling.goto(base+`/ledger/${f.ledgerId}/bills/${f.billId}/edit`);await expect(sibling.locator('[data-edit-protection]')).toContainText('is editing',{timeout:60000});pass('B06 same-user tabs compete as distinct editors')
    const entry=await a.newPage();await entry.goto(base+`/ledger/${f.ledgerId}/entries/${f.entryId}`);await expect(entry.locator('input[name="editToken"]')).not.toHaveValue('',{timeout:60000});pass('B07 manual draft editor obtains protected version')
    await entry.locator('input[name="description"]').fill('Unsaved manual entry input')
    await entry.getByRole('button',{name:'Stop editing',exact:true}).click();await expect(entry.locator('[data-edit-protection]:has(input[name="editToken"])')).toContainText('Editing stopped',{timeout:60000})
    await expect(entry.locator('input[name="description"]')).toHaveValue('Unsaved manual entry input')
    const [stoppedLease]=await database`SELECT expires_at>clock_timestamp() AS live FROM document_edit_lease WHERE journal_entry_id=${f.entryId}`;if(stoppedLease.live)throw Error('Stop editing did not release actual lease')
    const embed=await a.newPage();await embed.goto(base+'/settings/security')
    let iframeNavigations=0;embed.on('framenavigated',frame=>{if(frame.url().endsWith('/entries/'+f.entryId))iframeNavigations++})
    // Seed the existing Desk persistence, then operate the actual Desk tabs.
    // Appending an unmanaged iframe to a hydrating React body reloads it;
    // that does not reproduce FigTree's stable, React-owned iframe lifecycle.
    await embed.evaluate(href=>localStorage.setItem('erp.desk.v1',JSON.stringify({tabs:[{id:'t1',href},{id:'t2',href:'/settings/security'}],active:'t1'})),`/ledger/${f.ledgerId}/entries/${f.entryId}`)
    await embed.goto(base+'/')
    try{await expect(embed.frameLocator('iframe[data-frame="t1"]').locator('input[name="editToken"]')).not.toHaveValue('',{timeout:20000})}catch{
      const frames=[];for(const view of [...entry.frames(),...embed.frames()]){
        if(!view.url().endsWith('/entries/'+f.entryId))continue
        frames.push(await view.evaluate(()=>{const w=window as Window & {__figtreeEditorProofs?:Map<string,{tabId:string;epoch:number;token?:string;generation?:string}>;__figtreePausedEditors?:Set<string>};return {url:location.href,proofs:Array.from(w.__figtreeEditorProofs??[]).map(([key,value])=>({key,tabId:value.tabId,epoch:value.epoch,hasToken:!!value.token,generation:value.generation})),paused:Array.from(w.__figtreePausedEditors??[]),status:document.querySelector('[data-edit-protection]:has(input[name="editToken"])')?.textContent}}))
      }
      const rows=await database`SELECT tab_id::text,generation::text,expires_at>clock_timestamp() AS live FROM document_edit_lease WHERE journal_entry_id=${f.entryId}`
      throw Error('Real Desk proof diagnostic: '+JSON.stringify({iframeNavigations,frames,rows}))
    }
    const [expiry]=await database`SELECT expires_at::text FROM document_edit_lease WHERE journal_entry_id=${f.entryId}`
    await embed.locator('[role="tab"][data-tab="t2"]').click();await expect(embed.locator('iframe[data-frame="t1"]')).toBeHidden()
    await new Promise(resolve=>setTimeout(resolve,35000))
    const [hidden]=await database`SELECT expires_at::text FROM document_edit_lease WHERE journal_entry_id=${f.entryId}`
    if(hidden.expires_at!==expiry.expires_at)throw Error('Hidden iframe or stopped editor renewed lease')
    await expect(entry.locator('input[name="description"]')).toHaveValue('Unsaved manual entry input')
    pass('B12 hidden iframe and stopped editor do not renew across actual heartbeat interval')
    await p.goto(base+'/settings/security');await expect(p.getByRole('heading',{name:'Account security'})).toBeVisible({timeout:60000});await measure(p,'security-before-enrollment')
    await p.locator('input[name="password"]').fill(f.password);await p.getByRole('button',{name:'Verify identity',exact:true}).click();await expect(p.getByRole('status')).toContainText('Identity verified',{timeout:60000})
    await p.getByRole('button',{name:'Set up authenticator',exact:true}).click();await expect(p.locator('form code')).toBeVisible({timeout:60000})
    const [pending]=await database`SELECT id::text,mfa_pending_ciphertext FROM app_user WHERE email=${f.email}`
    process.env.AUTH_MFA_KEY=key;const secret=decryptMfa(pending.mfa_pending_ciphertext,pending.id)
    await p.locator('input[name="code"]').fill(totp(secret));await p.getByRole('button',{name:'Confirm setup code',exact:true}).click();await expect(p.locator('form pre')).toBeVisible({timeout:60000});await expect(p.getByText('Authenticator enabled',{exact:true})).toBeVisible();const codes=(await p.locator('form pre').innerText()).split('\n');if(codes.length!==10)throw Error('Recovery codes not shown once');pass('B08 real enrollment verifies TOTP, refreshes enabled status and exposes one-time recovery codes')
    const fresh=await browser.newContext(),mfa=await fresh.newPage();await mfa.goto(base+'/login');await mfa.getByLabel('Email',{exact:true}).fill(f.email);await mfa.getByLabel('Password',{exact:true}).fill(f.password);await mfa.getByRole('button',{name:'Sign in',exact:true}).click();await expect(mfa.locator('form [role="alert"]')).toContainText('do not match',{timeout:60000});if((await fresh.cookies()).some(c=>c.name==='erp_session'))throw Error('Password-only login issued session');pass('B09 MFA password-only login refused by actual endpoint')
    await mfa.locator('input[name="factor"]').fill(codes[0]);await mfa.getByRole('button',{name:'Sign in',exact:true}).click();await mfa.waitForURL(url=>!url.pathname.startsWith('/login'),{timeout:60000});pass('B10 recovery code signs in through actual login endpoint')
    const after=await measure(p,'security-after-enrollment')
    if(after.filter(e=>e.tag==='INPUT').some(e=>!e.visible || e.x<0 || e.x+e.width>1440))throw Error('Security inputs outside desktop viewport')
    await p.screenshot({path:join(evidence,'security-enrollment.png'),fullPage:true,mask:[p.locator('form code'),p.locator('form pre')]})
    await p.setViewportSize({width:390,height:844});await p.goto(base+'/settings/security')
    const mobile=await measure(p,'security-mobile')
    if(mobile.filter(e=>e.tag==='INPUT').some(e=>!e.visible || e.x<0 || e.x+e.width>390))throw Error('Security inputs outside mobile viewport')
    const inputs=mobile.filter(e=>e.tag==='INPUT');if(inputs.length!==2 || inputs[0].y+inputs[0].height>inputs[1].y)throw Error('Security inputs overlap')
    pass('B11 measured desktop/mobile security inputs visible, contained and nonoverlapping')
    await q.goto(base+'/settings/security');const policyBefore=await measure(q,'security-peer-before-admin-policy')
    server.kill('SIGTERM');await new Promise<void>(resolve=>{if(server.exitCode!==null)resolve();else server.once('exit',()=>resolve())})
    server=spawn('node',[nextBin,'start','--hostname','127.0.0.1','--port',String(port)],{cwd:scratch,env:{...runtimeEnv,AUTH_ADMIN_MFA_REQUIRED:'true'},stdio:['ignore','pipe','pipe']})
    server.stdout.on('data',b=>{serverLog+=String(b)});server.stderr.on('data',b=>{serverLog+=String(b)})
    for(let n=0;n<120;n++){if(server.exitCode!==null)throw Error('Admin policy server exited');try{if((await fetch(base+'/login')).ok)break}catch{}if(n===119)throw Error('Admin policy server readiness timeout');await new Promise(resolve=>setTimeout(resolve,500))}
    // Replay an actual accounting Server Action at the enrollment URL. URL
    // exceptions must never grant an unbound administrator a different action.
    const body=posted.postDataBuffer();if(!body)throw Error('No actual accounting action request captured')
    const bypass=await q.request.post(base+'/settings/security',{headers:{'next-action':posted.headers()['next-action'],'content-type':posted.headers()['content-type'],origin:base},data:body,maxRedirects:0})
    if(!bypass.headers()['x-action-redirect']?.includes('/settings/security'))throw Error('Enrollment URL bypassed required admin MFA action gate')
    await q.goto(base+invoice);await q.waitForURL(base+'/settings/security')
    const policyAfter=await measure(q,'security-peer-after-admin-policy')
    const bounds=(rows:typeof policyBefore)=>rows.filter(e=>e.tag==='INPUT').map(({x,y,width,height})=>({x,y,width,height}))
    if(JSON.stringify(bounds(policyBefore))!==JSON.stringify(bounds(policyAfter)))throw Error('Admin enrollment policy changed security input layout')
    await q.locator('input[name="password"]').fill(f.password);await q.getByRole('button',{name:'Verify identity',exact:true}).click();await expect(q.getByRole('status')).toContainText('Identity verified')
    await q.getByRole('button',{name:'Set up authenticator',exact:true}).click();await expect(q.locator('form code')).toBeVisible()
    pass('B13 required admin MFA blocks accounting action at enrollment URL and permits real enrollment')
    await writeFile(join(evidence,'browser-measurements.json'),JSON.stringify(measurements,null,2)+'\n')
    await writeFile(join(evidence,'browser.md'),['# P1 real browser verification','',...checks.map(c=>'- '+c),'','Measurements: [actual DOM rectangles](browser-measurements.json). Screenshot: [conflict with synthetic data](invoice-conflict.png).','No real users, credentials or book data were used.'].join('\n')+'\n')
    console.log('=== ALL CHECKS PASSED ===')
  }finally{await browser.close();await database.end();server.kill('SIGTERM');await new Promise<void>(resolve=>{if(server.exitCode!==null)resolve();else server.once('exit',()=>resolve())});await writeFile(join(evidence,'browser-server.log'),serverLog.split('\n').filter(line=>!line.includes('└─ ƒ')).join('\n'));await rm(scratch,{recursive:true,force:true})}
}
main().catch(e=>{console.error(e instanceof Error?e.message:'Browser verification failed');process.exitCode=1})
