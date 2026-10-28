import {readFileSync,writeFileSync,mkdtempSync} from 'node:fs'
import {spawn,spawnSync} from 'node:child_process'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createServer as httpsServer} from 'node:https'
import {request as httpRequest} from 'node:http'
import {randomBytes,randomUUID} from 'node:crypto'
import {PDFDocument} from 'pdf-lib'
import {parse} from 'dotenv'
import {chromium,expect,type Page} from '@playwright/test'

async function measurement(page:Page) {
  await page.evaluate(async()=>{await document.fonts.ready;await new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r())))})
  return page.evaluate(()=>({path:location.pathname,width:innerWidth,scrollWidth:document.documentElement.scrollWidth,
    controls:Array.from(document.querySelectorAll('button,a,input,select,textarea,h1,h2')).flatMap((node)=>{
      const el=node as HTMLElement,r=el.getBoundingClientRect(),s=getComputedStyle(el)
      if(r.width<=0||r.height<=0||s.visibility==='hidden'||s.display==='none'||(el instanceof HTMLInputElement&&el.type==='hidden'))return []
      return [{tag:el.tagName,id:el.id,name:el.getAttribute('name')??'',ariaLabel:el.getAttribute('aria-label')??'',text:el.innerText?.trim().replace(/\s+/g,' ').slice(0,160)??'',href:el.getAttribute('href'),x:r.x,y:r.y,width:r.width,height:r.height}]
    })}))
}
async function health(page:Page){
  return page.evaluate(()=>{
    const root=document.querySelector('main[data-automation-workspace]')??document.querySelector('main')!,bounds=root.getBoundingClientRect()
    const visible=(el:Element)=>{const s=getComputedStyle(el),r=el.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0}
    const elements=Array.from(root.querySelectorAll('button,a,input,select,textarea')).filter(e=>visible(e)&&!(e instanceof HTMLInputElement&&e.type==='hidden'))
    const overlaps:string[]=[],outside:string[]=[],svgErrors:string[]=[]
    const label=(e:Element)=>e.getAttribute('aria-label')??e.getAttribute('name')??e.textContent?.trim().slice(0,80)??e.tagName
    for(let i=0;i<elements.length;i++){
      const a=elements[i],r=a.getBoundingClientRect()
      if(r.left<bounds.left-1||r.right>bounds.right+1)outside.push(label(a))
      for(let j=i+1;j<elements.length;j++){
        const b=elements[j];if(a.contains(b)||b.contains(a))continue
        const s=b.getBoundingClientRect();if(Math.min(r.right,s.right)-Math.max(r.left,s.left)>1&&Math.min(r.bottom,s.bottom)-Math.max(r.top,s.top)>1)overlaps.push(label(a)+' / '+label(b))
      }
    }
    const svgs=Array.from(root.querySelectorAll('svg')).filter(visible)
    for(const svg of svgs){const box=svg.viewBox.baseVal;if(!Number.isFinite(box.width)||!Number.isFinite(box.height)||box.width<=0||box.height<=0)svgErrors.push('Invalid SVG viewBox')}
    return {controls:elements.length,svgCount:svgs.length,overlaps,outside,svgErrors,scrollWidth:document.documentElement.scrollWidth,width:innerWidth}
  })
}
async function loaded(page:Page,url:string) {
  await page.goto(url,{waitUntil:'networkidle'})
  await page.waitForFunction(()=>document.body.innerText.length>100&&!/Loading[….]/.test(document.body.innerText),{},{timeout:30000})
  await page.locator('h1').first().waitFor({state:'visible'})
}
async function saveInbound(page:Page){
  await Promise.all([page.waitForResponse(r=>r.request().method()==='POST'&&!!r.request().headers()['next-action']),page.getByRole('button',{name:'Save inbound configuration'}).click()])
  await page.waitForFunction(()=>!document.querySelector('form fieldset:disabled'))
  const refused=page.locator('p[role=alert]');if(await refused.count())throw Error('Inbound configuration refused: '+await refused.innerText())
  await page.getByRole('status').filter({hasText:'Saved. Review the current status.'}).waitFor()
}
async function main(){
  const proof=JSON.parse(readFileSync('docs/evidence/p5/isolation.json','utf8')),env={...process.env,...parse(readFileSync(proof.environmentPath))}
  if(!proof.createdNew||proof.productionTouched||new URL(env.DATABASE_URL!).pathname.slice(1)!==proof.applicationDatabase)throw Error('Unconfirmed APP browser target')
  const f=JSON.parse(readFileSync(proof.browserFixturePath,'utf8')),port=4035,before=process.argv.includes('--before'),origin=before?'http://127.0.0.1:'+port:'https://127.0.0.1:4435'
  let tls:ReturnType<typeof httpsServer>|undefined
  if(!before){
    const dir=mkdtempSync(join(tmpdir(),'figtree-p5-local-tls-')),key=join(dir,'key.pem'),cert=join(dir,'cert.pem')
    const created=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=127.0.0.1'],{stdio:'ignore'})
    if(created.status!==0)throw Error('Local TLS fixture could not be created')
    env.P5_PUBLIC_ORIGIN=origin;env.INBOUND_MAIL_ENABLED='true';env.POSTMARK_INGRESS_IP_FILTER_CONFIGURED='true'
    tls=httpsServer({key:readFileSync(key),cert:readFileSync(cert)},(incoming,outgoing)=>{
      if(incoming.socket.remoteAddress!=='127.0.0.1'){outgoing.writeHead(403);outgoing.end();return}
      const upstream=httpRequest({host:'127.0.0.1',port,path:incoming.url,method:incoming.method,headers:{...incoming.headers,'x-forwarded-proto':'https','x-forwarded-host':'127.0.0.1:4435'}},response=>{outgoing.writeHead(response.statusCode??502,response.headers);response.pipe(outgoing)})
      upstream.on('error',()=>{outgoing.writeHead(502);outgoing.end()});incoming.pipe(upstream)
    })
    await new Promise<void>(resolve=>tls!.listen(4435,'127.0.0.1',resolve))
  }
  const server=spawn('npm',['run','start','--','--hostname','127.0.0.1','--port',String(port)],{env,stdio:'ignore',detached:true})
  let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined
  try {
    let ready=false
    for(let i=0;i<120;i++){try{const r=await fetch('http://127.0.0.1:'+port+'/login');if(r.ok){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,500))}
    if(!ready)throw Error('P5 preview server did not start')
    browser=await chromium.launch({headless:true});const context=await browser.newContext({ignoreHTTPSErrors:true})
    // tsx/esbuild retains nested function names in evaluated measurement code.
    await context.addInitScript('globalThis.__name = (fn) => fn')
    await context.addCookies([{name:'erp_session',value:f.token,url:origin,httpOnly:true,secure:!before,sameSite:'Lax'}])
    const page=await context.newPage(),records=[]
    for(const width of [1440,900]){
      await page.setViewportSize({width,height:1000})
      for(const [label,path] of [['invoice',`/ledger/${f.ledgerId}/invoices/${f.invoiceId}`],['automation',`/ledger/${f.ledgerId}/automation`],['inbox',`/ledger/${f.ledgerId}/automation/inbox`]]){
        await loaded(page,origin+path);records.push({label,...await measurement(page)})
        await page.screenshot({path:`docs/evidence/p5/${before?'before':'after'}-${label}-${width}.png`,fullPage:true})
      }
    }
    writeFileSync(`docs/evidence/p5/browser-${before?'before':'after'}.json`,JSON.stringify(records,null,2)+'\n')
    if(before){console.log('PASS P5UI01 captured six loaded reference route/viewport measurements');return}
    if(process.argv.includes('--measure-settings')){const settings=[];for(const width of [1440,900])for(const label of ['payments','inbound']){await page.setViewportSize({width,height:1000});await loaded(page,origin+`/settings/services?ledger=${f.ledgerId}&section=${label}`);settings.push({label,...await measurement(page)})}writeFileSync('docs/evidence/p5/settings-before-picker.json',JSON.stringify(settings,null,2)+'\n');console.log('PASS measured actual new settings as the current Picker reference');return}
    let count=0;const check=(ok:boolean,label:string)=>{if(!ok)throw Error(label);console.log('PASS '+label);count++}
    const original=JSON.parse(readFileSync('docs/evidence/p5/browser-before.json','utf8')) as typeof records,comparison=[]
    for(const after of records){
      const old=original.find(b=>b.label===after.label&&b.width===after.width)!,ordinals=new Map<string,number>(),differences=[]
      const key=(c:typeof old.controls[number])=>JSON.stringify([c.tag,c.id,c.name,c.text,c.href])
      for(const c of old.controls){const k=key(c),index=ordinals.get(k)??0;ordinals.set(k,index+1);const current=after.controls.filter(n=>key(n)===k)[index];if(!current||['x','y','width','height'].some(d=>Math.abs(current[d as 'x']-c[d as 'x'])>1))differences.push({before:c,after:current})}
      comparison.push({label:after.label,width:after.width,differences});check(!differences.length&&after.scrollWidth<=after.width,`P5UI02-${after.label}-${after.width} original controls preserved within 1px; no page overflow`)
    }
    writeFileSync('docs/evidence/p5/browser-comparison.json',JSON.stringify(comparison,null,2)+'\n')
    await page.setViewportSize({width:1440,height:1000});await loaded(page,origin+`/settings/services?ledger=${f.ledgerId}&section=payments`)
    for(const [label,option]of [['Stripe clearing account','1100 — Stripe clearing'],['Processor fee expense','5000 — Payment processing fees'],['Payout bank account','1000 — Bank']]){await page.getByRole('combobox',{name:label}).fill(option);await page.getByRole('option',{name:option,exact:true}).click()}
    if(await page.getByRole('button',{name:'Administrator takeover'}).count())await page.getByRole('button',{name:'Administrator takeover'}).click()
    await page.getByRole('button',{name:'Save disabled configuration'}).click()
    await page.getByRole('button',{name:'Verify merchant'}).waitFor()
    if(await page.getByRole('button',{name:'Administrator takeover'}).count())await page.getByRole('button',{name:'Administrator takeover'}).click()
    await page.waitForFunction(()=>document.body.innerText.includes('Editing as '))
    const disabledStatus=await context.request.get(origin+`/ledger/${f.ledgerId}/automation/payments`)
    check(disabledStatus.ok()&&(await disabledStatus.text()).includes('New payments disabled'),'P5UI03 real disabled configuration saved through protected UI and shown on its operational feed')
    const otherTab=await context.newPage();await loaded(otherTab,page.url());await otherTab.getByText('is editing until',{exact:false}).waitFor()
    await otherTab.getByRole('button',{name:'Administrator takeover'}).click();await otherTab.waitForFunction(()=>document.body.innerText.includes('Editing as '))
    await page.getByRole('button',{name:'Save disabled configuration'}).click();await page.waitForFunction(()=>Array.from(document.querySelectorAll('[role=alert]')).some(e=>e.textContent?.trim()))
    check(/holds this document|lease expired|document changed/.test(await page.locator('p[role=alert]').innerText()),'P5UI04 alert='+await page.locator('p[role=alert]').innerText()+' — second-tab takeover blocks stale configuration save and preserves input')
    await otherTab.close()
    await loaded(page,origin+`/ledger/${f.ledgerId}/invoices/${f.invoiceId}`);await page.getByRole('button',{name:'Create invoice link'}).click()
    const link=await page.getByRole('status').filter({hasText:'Share this limited link'}).innerText(),match=link.match(/https:\/\/127\.0\.0\.1:4435\/pay\/[a-f0-9-]+#[A-Za-z0-9_-]+/)
    if(!match)throw Error('Actual UI did not return an invitation link')
    const customer=await browser.newContext({ignoreHTTPSErrors:true});await customer.addInitScript('globalThis.__name = (fn) => fn')
    const visitor=await customer.newPage(),requests:string[]=[]
    visitor.on('request',request=>requests.push(request.url()))
    await visitor.goto(match[0],{waitUntil:'networkidle'});check(!requests.some(url=>url.includes('/session')),'P5UI05 GET scanner does not exchange invitation or expose invoice')
    await visitor.getByRole('button',{name:'Open invoice'}).click();await visitor.getByRole('heading',{name:'P5-1000'}).waitFor()
    const cookie=(await customer.cookies()).find(c=>c.name==='figtree_portal')
    check(!!cookie?.secure&&cookie.httpOnly&&cookie.sameSite==='Strict'&&!visitor.url().includes('#'),'P5UI06 gesture establishes secure HttpOnly scoped session and clears fragment')
    check(!requests.some(url=>new URL(url).origin!==origin),'P5UI07 public portal has no external scripts or tracking requests')
    const download=await customer.request.get(origin+new URL(match[0]).pathname+'/pdf')
    check(download.ok()&&(await download.body()).subarray(0,5).toString()==='%PDF-'&&download.headers()['cache-control'].includes('no-store'),'P5UI08 actual protected customer PDF is downloadable and private')
    const foreign=await customer.request.get(origin+'/pay/00000000-0000-4000-8000-000000000001/status')
    check(foreign.status()===404,'P5UI09 scoped portal cookie cannot read another invoice invitation')
    const denied=await customer.request.post(origin+new URL(match[0]).pathname+'/checkout',{headers:{origin},data:{amount:1}})
    check(denied.status()===400,'P5UI10 client amount substitution is rejected before payment provider I/O')
    const disabled=await customer.request.post(origin+new URL(match[0]).pathname+'/checkout',{headers:{origin},data:{}})
    check(disabled.status()===409,'P5UI11 disabled new-payment path fails honestly without fake provider success')
    await visitor.screenshot({path:'docs/evidence/p5/portal-open.png',fullPage:true})
    const portalHealth=await health(visitor);check(!portalHealth.overlaps.length&&!portalHealth.outside.length&&!portalHealth.svgErrors.length,'P5UI17 portal controls have no overlap, clipping or invalid visible SVG')
    const invitationPath=new URL(match[0]).pathname,invitationId=invitationPath.split('/').at(-1)!
    const revokeForm=page.locator('form').filter({has:page.locator('input[name="id"][value="'+invitationId+'"]')})
    await revokeForm.getByRole('button',{name:'Revoke link',exact:true}).click()
    // A click can return before the server action commits. Check this link's
    // actual access refusal before asking the already-open portal to refresh.
    await expect.poll(async()=>(await customer.request.get(origin+invitationPath+'/status')).status(),{timeout:15000}).toBe(404)
    await visitor.getByRole('button',{name:'Refresh status'}).click();await expect(visitor.locator('p[role=alert]')).toContainText('unavailable')
    check((await visitor.locator('p[role=alert]').innerText()).includes('unavailable'),'P5UI12 live revocation stops an already-open portal session')
    await customer.close()
    await loaded(page,origin+`/settings/services?ledger=${f.ledgerId}&section=inbound`)
    if(await page.getByRole('button',{name:'Administrator takeover'}).count())await page.getByRole('button',{name:'Administrator takeover'}).click()
    if(await page.locator('input[name=id]').inputValue())await page.waitForFunction(()=>document.body.innerText.includes('Editing as '))
    const username='p5-local-ui-user',password=randomBytes(30).toString('base64url')
    await page.locator('[name=providerAccount]').fill('P5UIserver');await page.locator('[name=recipientBase]').fill('p5uiroute@inbound.postmarkapp.com');await page.locator('[name=username]').fill(username);await page.locator('[name=password]').fill(password)
    await saveInbound(page);await page.waitForFunction(()=>document.body.innerText.includes('Editing as '))
    await page.locator('[name=enabled]').check();await saveInbound(page);await loaded(page,origin+`/ledger/${f.ledgerId}/automation/inbound`);await page.waitForFunction(()=>document.querySelector('main')?.textContent?.includes('Postmark · Enabled'))
    const text=await page.locator('main[data-automation-workspace]').innerText(),alias=text.match(/p5uiroute\+[a-f0-9]+@inbound\.postmarkapp\.com/)?.[0],connectionId=text.match(/\/integrations\/postmark\/([a-f0-9-]+)/)?.[1]
    if(!alias||!connectionId)throw Error('Actual inbound route not configured')
    const pdf=await PDFDocument.create();pdf.addPage([300,300]);const bytes=Buffer.from(await pdf.save()),payload={MessageID:'P5UI-'+randomUUID(),OriginalRecipient:alias,From:'untrusted@example.test',Subject:'Local protocol fixture',Attachments:[{Name:'Local.pdf',ContentType:'application/pdf',ContentLength:bytes.length,Content:bytes.toString('base64')}]},auth='Basic '+Buffer.from(username+':'+password).toString('base64')
    const invalid=await context.request.post(origin+'/integrations/postmark/'+connectionId,{data:payload})
    check(invalid.status()===403,'P5UI13 provider route rejects a delivery without Basic credentials')
    const received=await context.request.post(origin+'/integrations/postmark/'+connectionId,{headers:{authorization:auth},data:payload}),repeat=await context.request.post(origin+'/integrations/postmark/'+connectionId,{headers:{authorization:auth},data:payload})
    check(received.ok()&&repeat.ok(),'P5UI14 synthetic protocol fixture reaches real authenticated HTTPS handler and database (external Postmark unverified); statuses '+received.status()+'/'+repeat.status())
    await page.reload({waitUntil:'networkidle'});await page.getByRole('heading',{name:'Local protocol fixture'}).first().waitFor()
    const review=page.getByRole('link',{name:'Review in inbox'}).first();await review.click();await page.getByRole('heading').first().waitFor()
    check((await page.locator('body').innerText()).includes('Local.pdf'),'P5UI15 inbound attachment opens current manual inbox review')
    const settings=[],healthResults=[{label:'portal',...portalHealth}],pickerComparisons=[],pickerDifferences=[]
    const beforePicker=JSON.parse(readFileSync('docs/evidence/p5/settings-before-picker.json','utf8'))
    for(const width of [1440,900])for(const label of ['payments','inbound']){
      await page.setViewportSize({width,height:1000});await loaded(page,origin+`/settings/services?ledger=${f.ledgerId}&section=${label}`)
      const m=await measurement(page),h=await health(page);settings.push({label,...m});healthResults.push({label,...h})
      check(m.scrollWidth<=width&&!h.overlaps.length&&!h.outside.length&&!h.svgErrors.length,`P5UI16-${label}-${width} controls fit workspace without overlap or invalid visible SVG`)
      if(label==='payments')for(const[name,aria]of [['clearingId','Stripe clearing account'],['feeId','Processor fee expense'],['bankId','Payout bank account']]){
        const before=beforePicker.find((b:{label:string;width:number})=>b.label===label&&b.width===width),old=before.controls.find((c:{name:string;ariaLabel:string})=>c.name===name||c.ariaLabel===aria)
        const current=m.controls.find(c=>c.ariaLabel===aria)
        const anchor=before.controls.find((c:{name:string})=>c.name==='mode'),nowAnchor=m.controls.find(c=>c.name==='mode')!,shift=nowAnchor.y-anchor.y
        const unrelatedFieldsAgree=['timezone','key','webhook'].every(field=>{const oldField=before.controls.find((c:{name:string})=>c.name===field),now=m.controls.find(c=>c.name===field)!;return Math.abs(now.y-oldField.y-shift)<=1})
        const geometryPreserved=!!old&&!!current&&['x','width','height'].every(d=>Math.abs(old[d]-current[d as 'x'])<=1)&&Math.abs(current.y-old.y-shift)<=1&&unrelatedFieldsAgree
        pickerComparisons.push({width,name,before:old,after:current,leaseBannerVerticalShift:shift,unrelatedFieldsAgree,geometryPreserved})
        if(!geometryPreserved)pickerDifferences.push({width,name,before:old,after:current})
      }
      await page.screenshot({path:`docs/evidence/p5/${label}-${width}.png`,fullPage:true})
    }
    writeFileSync('docs/evidence/p5/settings-after-picker.json',JSON.stringify(settings,null,2)+'\n');writeFileSync('docs/evidence/p5/layout-health.json',JSON.stringify(healthResults,null,2)+'\n');writeFileSync('docs/evidence/p5/picker-comparison.json',JSON.stringify({checks:pickerComparisons,errors:pickerDifferences},null,2)+'\n')
    check(!pickerDifferences.length,'P5UI18 account Picker size and relative grid spacing preserved within 1px; lease banner displacement explicitly recorded')
    writeFileSync('docs/evidence/p5/browser-result.json',JSON.stringify({checks:count,passed:true,externalStripeVerified:false,externalPostmarkVerified:false},null,2)+'\n')
  }finally{
    await browser?.close()
    if(server.pid)try{process.kill(-server.pid,'SIGTERM')}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw e}
    if(tls)await new Promise<void>(resolve=>tls!.close(()=>resolve()))
  }
}
main().catch(e=>{console.error(e instanceof Error?e.message:'P5 browser failed');process.exitCode=1})
