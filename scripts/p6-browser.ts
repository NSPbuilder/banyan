/** Real production application, server actions, PostgreSQL and Chromium WebAuthn. */
import {chromium,expect,type Page} from '@playwright/test'
import {readFile,writeFile,mkdtemp,cp,constants} from 'node:fs/promises'
import {spawn,spawnSync} from 'node:child_process'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {parse} from 'dotenv'
import {reporter} from './suite'
const r=reporter(85)
async function main(){
  const proof=JSON.parse(await readFile('docs/evidence/p6/isolation.json','utf8')),config=parse(await readFile(proof.environmentPath))
  if(!proof.createdNew||proof.productionTouched||new URL(config.DATABASE_URL).pathname.slice(1)!==proof.applicationDatabase)throw Error('Unconfirmed APP')
  const f=JSON.parse(await readFile(proof.browserFixturePath,'utf8')),scratch=await mkdtemp(join(tmpdir(),'figtree-p6-browser-build-'))
  const env:NodeJS.ProcessEnv={...process.env,...config,NODE_OPTIONS:'',NODE_ENV:'production'}
  const retainedBuildId=process.env.P6_CURRENT_BUILD_ID,buildRoot=retainedBuildId?process.cwd():scratch
  if(retainedBuildId){
    if((await readFile(join(buildRoot,'.next/BUILD_ID'),'utf8')).trim()!==retainedBuildId)throw Error('Confirmed current production build ID mismatch')
    console.log('Using explicitly confirmed current production build '+retainedBuildId)
  }else{
    for(const p of ['src','public','package.json','tsconfig.json','next.config.ts','postcss.config.mjs','next-env.d.ts','node_modules'])await cp(p,join(scratch,p),{recursive:true,mode:constants.COPYFILE_FICLONE})
    const built=spawnSync('node',[join(buildRoot,'node_modules/next/dist/bin/next'),'build'],{cwd:buildRoot,env,encoding:'utf8',maxBuffer:24e6})
    await writeFile('docs/evidence/p6/browser-build.log',built.stdout+built.stderr)
    if(built.status!==0)throw Error('Browser build failed')
  }
  const server=spawn('node',[join(buildRoot,'node_modules/next/dist/bin/next'),'start','--hostname','127.0.0.1','--port','3096'],{cwd:buildRoot,env,stdio:'ignore'})
  const browser=await chromium.launch({headless:true}),context=await browser.newContext(),page=await context.newPage(),cdp=await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable');await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}})
  const origin='http://localhost:3096',goto=async(p:Page,path:string)=>{await p.goto(origin+path);await p.locator('main h1').waitFor()}
  try{
    for(let n=0;n<120;n++){try{if((await fetch(origin+'/login')).ok)break}catch{}if(n===119)throw Error('Readiness failed');await new Promise(r=>setTimeout(r,500))}
    await context.addCookies([{name:'erp_session',value:f.token,domain:'localhost',path:'/'}])
    await goto(page,'/settings/security')
    await page.getByLabel('Current password',{exact:true}).fill(f.password);await page.getByRole('button',{name:'Verify identity',exact:true}).click()
    await expect(page.getByRole('status').filter({hasText:'Identity verified'})).toBeVisible()
    r.pass('P6B01 actual password reauthentication server action works')
    const keys=page.getByRole('region',{name:'Passkeys',exact:true})
    const deviceName='P6 browser device '+Date.now(),renamedName='Renamed '+deviceName
    await keys.getByLabel('New passkey name').fill(deviceName);await keys.getByRole('button',{name:'Add passkey',exact:true}).click()
    await expect(keys.getByRole('status').filter({hasText:'Passkey added'})).toBeVisible({timeout:20000})
    r.pass('P6B02 real application registration through browser library and server action')
    await keys.getByRole('button',{name:'Manage passkey '+deviceName,exact:true}).click()
    const management=page.getByRole('dialog'),form=management.locator('form')
    await form.locator('input[name="name"]').fill(renamedName);await form.getByRole('button',{name:'Rename',exact:true}).click()
    await expect(management.getByRole('status').filter({hasText:'Passkey renamed'})).toBeVisible()
    if(await management.isVisible())await management.getByRole('button',{name:'Close',exact:true}).click()
    await page.waitForFunction(()=>!document.querySelector('dialog[open]')||!!document.querySelector('dialog.unsaved-dialog[open]'))
    const discard=page.getByRole('dialog',{name:/^(Discard unsaved changes|Close without saving)\?$/})
    // The rename was acknowledged above. Confirm closing any remaining local
    // form state, then independently check the saved name on the device list.
    if(await discard.isVisible())await discard.getByRole('button',{name:/^(Discard changes|Close without saving)$/}).click()
    await expect(page.locator('dialog[open]')).toHaveCount(0)
    await expect(keys.getByRole('button',{name:'Manage passkey '+renamedName,exact:true})).toBeVisible()
    r.pass('P6B03 name management works in actual application')
    await keys.getByRole('button',{name:'Verify with a passkey',exact:true}).click()
    await expect(keys.getByRole('status').filter({hasText:'Identity verified for five minutes'})).toBeVisible()
    r.pass('P6B04 actual passkey reauthentication renews existing session')
    await context.clearCookies();await goto(page,'/login')
    await page.getByRole('button',{name:'Sign in with a passkey',exact:true}).click();await page.waitForURL(url=>!url.pathname.startsWith('/login'))
    const session=(await context.cookies()).find(c=>c.name==='erp_session');if(!session)throw Error('No application session cookie')
    f.token=session.value;await writeFile(proof.browserFixturePath,JSON.stringify(f),{mode:0o600})
    r.pass('P6B05 real application passkey login issues existing session cookie')
    await goto(page,'/audit');await page.getByRole('button',{name:'Verify audit now',exact:true}).click()
    await expect(page.getByRole('status').filter({hasText:'Audit verified.'})).toBeVisible()
    r.pass('P6B06 actual audit controls record and show verifier result')
    await page.getByRole('button',{name:'Create checkpoint',exact:true}).click()
    const download=page.getByRole('link',{name:'Download checkpoint JSON',exact:true});await expect(download).toBeVisible()
    const downloaded=await context.request.get(origin+await download.getAttribute('href'))
    if(!downloaded.ok())throw Error('Checkpoint download refused')
    const anchor=join(scratch,'independently-retained-checkpoint.json');await writeFile(anchor,await downloaded.body(),{mode:0o600})
    await page.getByLabel('Independently retained checkpoint').setInputFiles(anchor);await page.getByRole('button',{name:'Compare checkpoint',exact:true}).click()
    await expect(page.getByRole('status').filter({hasText:'supplied independently retained checkpoint'})).toBeVisible()
    r.pass('P6B07 actual checkpoint download, separate file retention and upload comparison')
    const account=`/ledger/${f.ledgerId}/accounts/${f.accountId}`,party=`/ledger/${f.ledgerId}/parties/${f.partyId}`
    const other=await context.newPage()
    async function openAccount(p:Page){await goto(p,account);await p.getByRole('button',{name:'Edit this account',exact:true}).click()}
    const editReady=async(p:Page)=>expect(p.locator('[data-edit-protection]')).toContainText('Editing as',{timeout:10000})
    await openAccount(page);await editReady(page);await openAccount(other)
    await expect(other.locator('[data-edit-protection]')).toContainText('editing until')
    r.pass('P6B08 second actual browser window cannot acquire held account lease')
    await other.locator('input[name="name"]').fill('Unsaved other window')
    await page.locator('input[name="name"]').fill('P6 browser renamed cash');await page.getByRole('button',{name:'Save',exact:true}).click()
    await expect(page.getByRole('status').filter({hasText:'1000 saved.'})).toBeVisible()
    await other.getByRole('button',{name:'Administrator takeover',exact:true}).click()
    await expect(other.locator('[data-edit-protection]')).toContainText('saved document changed')
    await other.getByRole('button',{name:'Save',exact:true}).click()
    await expect(other.getByRole('alert').filter({hasText:'changed'})).toBeVisible()
    await expect(other.locator('input[name="name"]')).toHaveValue('Unsaved other window')
    r.pass('P6B09 account stale save is refused and unsaved input survives takeover')
    await other.close();await goto(page,party);await editReady(page)
    const address=page.locator('form').filter({has:page.locator('input[name="line1"]')})
    const oldVersion=await address.locator('input[name="expectedVersion"]').inputValue()
    await address.locator('input[name="line1"]').fill('100 P6 browser street');await address.getByRole('button',{name:/^(Set|Save) address$/}).click()
    await expect(address.getByRole('status')).toBeVisible()
    await expect(address.locator('input[name="expectedVersion"]')).not.toHaveValue(oldVersion)
    const allVersions=await page.locator('[data-edit-boundary] form input[name="expectedVersion"]').evaluateAll(es=>es.map(e=>(e as HTMLInputElement).value))
    r.check(allVersions.length>=4&&new Set(allVersions).size===1,'P6B10 party address save propagates one current version to every actual form')
    const otherParty=await context.newPage();await goto(otherParty,party)
    await expect(otherParty.locator('[data-edit-protection]')).toContainText('editing until')
    await otherParty.locator('input[name="name"]').fill('Unsaved party window')
    await otherParty.getByRole('button',{name:'Administrator takeover',exact:true}).click();await editReady(otherParty)
    const identity=page.locator('form').filter({has:page.locator('input[name="name"]')})
    await identity.locator('input[name="name"]').fill('Lease stolen party input');await identity.getByRole('button',{name:'Save',exact:true}).click()
    await expect(identity.getByRole('alert')).toBeVisible();await expect(identity.locator('input[name="name"]')).toHaveValue('Lease stolen party input')
    r.pass('P6B11 actual shared party takeover rejects old generation and preserves input')
    await otherParty.close()
    const records=[]
    for(const width of [1440,900,390])for(const path of ['/settings/security','/audit',account,party]){
      await page.setViewportSize({width,height:1000});await goto(page,path)
      if(path===account)await page.getByRole('button',{name:'Edit this account',exact:true}).click()
      if(path===account||path===party){
        await expect(page.locator('[data-edit-protection]')).not.toContainText('Checking edit protection')
        // Closing a browser window may leave its lease until expiry. This owner
        // explicitly takes it over for a fresh layout capture, as the UI offers.
        const takeover=page.getByRole('button',{name:'Administrator takeover',exact:true})
        if(await takeover.count())await takeover.click()
        await editReady(page)
      }
      const record=await page.evaluate(()=>({pageWidth:innerWidth,scrollWidth:document.documentElement.scrollWidth,
        elements:Array.from(document.querySelectorAll('main h1,main form,main input:not([type="hidden"]),main button,main section')).map(e=>{
          const r=e.getBoundingClientRect();return {tag:e.tagName,name:e.getAttribute('name'),text:e.textContent?.slice(0,100),x:r.x,y:r.y,width:r.width,height:r.height}
        })}))
      records.push({width,path,...record})
      const seat=path==='/audit'?'audit':path===account?'account':path===party?'party':'security'
      await page.screenshot({path:`docs/evidence/p6/layout-after-${seat}-${width}.png`,fullPage:true})
    }
    await writeFile('docs/evidence/p6/layout-after.json',JSON.stringify({at:new Date().toISOString(),records},null,2)+'\n')
    console.log(r.summary());process.exitCode=r.failures?1:0
  }catch(e){await page.screenshot({path:'docs/evidence/p6/browser-failure.png',fullPage:true});throw e}
  finally{await browser.close();server.kill('SIGTERM')}
}
main().catch(e=>{console.error(e instanceof Error?e.message:'Browser acceptance failed');process.exitCode=1})
