/** Actual restricted-user navigation; only the confirmed synthetic APP. No reset. */
import {readFile,writeFile,stat} from 'node:fs/promises'
import {randomUUID,randomBytes} from 'node:crypto'
import assert from 'node:assert/strict'
import {parse} from 'dotenv'
import {chromium,expect} from '@playwright/test'

async function main(){
  const mode=process.argv[2];assert(['before','after'].includes(mode))
  const out='docs/evidence/workflow-placement-2026-10-09'
  const proof=JSON.parse(await readFile(out+'/isolation.json','utf8'))
  assert(proof.createdNew&&!proof.productionTouched)
  assert.equal((await stat(proof.environmentPath)).mode&0o777,0o600)
  const cfg=parse(await readFile(proof.environmentPath))
  assert.equal(new URL(cfg.DATABASE_URL).pathname.slice(1),proof.applicationDatabase)
  process.env.DATABASE_URL=cfg.DATABASE_URL
  const [{db,sql:connection},{sql},users,access]=await Promise.all([
    import('../src/db/client'),import('drizzle-orm'),import('../src/lib/users'),import('../src/lib/access'),
  ])
  const pointer=JSON.parse(await readFile('docs/evidence/ui-completion-2026-10-08/fixture.json','utf8'))
  const owner=JSON.parse(await readFile(pointer.privatePath,'utf8'))
  const privatePath=process.env.WORKFLOW_INBOX_FIXTURE_PATH??'/tmp/figtree-workflow-inbox-user.json',origin='http://localhost:3000'
  const L='/ledger/'+owner.ledgerId,inbox=L+'/readings/inbox',checks:string[]=[],errors:string[]=[]
  const [identity]=await db.execute<{name:string}>(sql`SELECT current_database() AS name`)
  assert.equal(identity.name,proof.applicationDatabase)
  let fixture:{userId:string;token:string}
  let exists=false;try{await stat(privatePath);exists=true}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}
  if(mode==='before'&&!exists){
    const password=randomBytes(32).toString('base64url'),email='inbox-'+randomUUID()+'@example.test'
    const user=await users.createUser({email,firstName:'Synthetic Inbox review',password,actor:'workflow-isolated-verifier'})
    await access.setGrants({userId:user.id,entityIds:[owner.entityId],modules:['/automation'],actor:'workflow-isolated-verifier'})
    const {token}=await users.signIn({email,password,userAgent:'workflow-inbox-access'})
    fixture={userId:user.id,token};await writeFile(privatePath,JSON.stringify(fixture),{mode:0o600})
  }else{assert.equal((await stat(privatePath)).mode&0o777,0o600);fixture=JSON.parse(await readFile(privatePath,'utf8'))}
  const browser=await chromium.launch({headless:true}),ctx=await browser.newContext({viewport:{width:1440,height:1000}})
  await ctx.addCookies([{name:'erp_session',value:fixture.token,domain:'localhost',path:'/',httpOnly:true,sameSite:'Lax'}])
  const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message))
  const check=(ok:boolean,label:string)=>{assert.ok(ok,label);checks.push(label);console.log('PASS',label)}
  const ready=async()=>{await expect(page.locator('main[aria-busy=true]')).toHaveCount(0,{timeout:20000});await expect(page.locator('main')).toBeVisible()}
  try{
    const held=await access.grantsOf(fixture.userId)
    const synthetic=await users.userById(fixture.userId)
    assert(synthetic?.email.startsWith('inbox-')&&synthetic.email.endsWith('@example.test')&&!synthetic.is_owner)
    check(held.modules.length===1&&held.modules[0]==='/automation','fixture has Automation only, no Readings or Assistant grant')
    await page.goto(origin+inbox,{waitUntil:'domcontentloaded'});await ready()
    if(mode==='before'){
      check(new URL(page.url()).pathname==='/no-access','baseline canonical Inbox adds an unintended grant requirement')
      await page.goto(origin+L+'/automation/inbox',{waitUntil:'domcontentloaded'});await ready()
      check(new URL(page.url()).pathname===L+'/automation/inbox','restricted user can still open legacy Inbox')
    }else check(new URL(page.url()).pathname===inbox,'restricted user can open canonical AI Inbox')
    const modes=page.getByRole('navigation',{name:'AI workspace modes'})
    check(await modes.getByRole('link').count()===1&&await modes.getByRole('link',{name:'Inbox',exact:true}).count()===1,'ungranted AI modes remain hidden')
    const back=page.locator('main header a[title=AI]'),href=await back.getAttribute('href')
    const geometry=await page.locator('main').evaluate(e=>({main:e.getBoundingClientRect().toJSON(),header:e.querySelector('header')?.getBoundingClientRect().toJSON(),overflow:document.documentElement.scrollWidth-innerWidth}))
    if(mode==='before'){
      check(href===L+'/readings','baseline exposes ungranted Readings back link')
      await back.click();await page.waitForURL('**/no-access?why=NO_MODULE');await ready()
      check(new URL(page.url()).pathname==='/no-access','baseline back link reproduces NO_MODULE')
    }else{
      check(href===inbox,'restricted back link resolves to allowed Inbox')
      await back.click();await expect(page).toHaveURL(origin+inbox);await ready()
      check(await page.getByRole('heading',{name:'Receipt inbox',exact:true}).count()===1,'restricted user can use back link without an access error')
      await page.goto(origin+L+'/readings',{waitUntil:'domcontentloaded'});await page.waitForURL('**/no-access?why=NO_MODULE');await ready()
      check(new URL(page.url()).pathname==='/no-access','direct ungranted Readings URL still refuses access')
      const [item]=await db.execute<{id:string}>(sql`SELECT id::text FROM inbox_item WHERE ledger_id=${owner.ledgerId}::uuid ORDER BY created_at DESC LIMIT 1`)
      assert(item,'Actual uploaded review receipt is required')
      await page.goto(origin+inbox+'/'+item.id,{waitUntil:'domcontentloaded'});await page.waitForURL('**/no-access?why=NO_MODULE');await ready()
      check(new URL(page.url()).pathname==='/no-access','Inbox detail keeps the existing invoice/entry grant checks')
      const ownerCtx=await browser.newContext();await ownerCtx.addCookies([{name:'erp_session',value:owner.token,domain:'localhost',path:'/',httpOnly:true,sameSite:'Lax'}])
      const ownerPage=await ownerCtx.newPage();await ownerPage.goto(origin+inbox,{waitUntil:'domcontentloaded'})
      await expect(ownerPage.locator('main[aria-busy=true]')).toHaveCount(0,{timeout:20000})
      check(await ownerPage.locator('main header a[title=AI]').getAttribute('href')===L+'/readings','owner keeps existing Readings back destination')
      check(await ownerPage.getByRole('navigation',{name:'AI workspace modes'}).getByRole('link',{name:'Read & add',exact:true}).count()===1,'owner Read & add mode uses actual route permissions')
      const before=JSON.parse(await readFile(out+'/inbox-access-before.json','utf8'))
      check(geometry.main.x===before.geometry.main.x&&geometry.main.width===before.geometry.main.width&&geometry.overflow===0,'restricted shell width and position stay stable, no overflow')
      await ownerCtx.close()
    }
    check(!errors.length,'no restricted navigation browser runtime errors')
    await page.goto(origin+(mode==='before'?L+'/automation/inbox':inbox),{waitUntil:'domcontentloaded'});await ready()
    await page.screenshot({path:out+'/screens/inbox-access-'+mode+'.png',fullPage:true})
    await writeFile(out+'/inbox-access-'+mode+'.json',JSON.stringify({mode,database:identity.name,syntheticUserId:fixture.userId,checks,errors,geometry,backHref:href},null,2)+'\n')
  }finally{
    await browser.close()
    if(mode==='after'){await users.setUserStatus({userId:fixture.userId,isActive:false,actor:'workflow-isolated-verifier'});console.log('Synthetic restricted user deactivated; sessions revoked')}
    await connection.end()
  }
}
main().catch(e=>{console.error(e);process.exitCode=1})
