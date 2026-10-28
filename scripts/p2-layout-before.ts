import { chromium } from '@playwright/test'
import { mkdtemp,cp,writeFile,readFile,constants } from 'node:fs/promises'
import { spawn,spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import dotenv from 'dotenv'

async function main() {
  const root=process.cwd(),evidence=join(root,'docs/evidence/p2')
  const config=dotenv.parse(await readFile('/tmp/figtree-p2-test.env')),proof=JSON.parse(await readFile(join(evidence,'isolation.json'),'utf8'))
  if(new URL(config.TEST_DATABASE_URL).pathname.slice(1)!==proof.testDatabase||config.TEST_DATABASE_CONFIRMATION!==proof.testDatabase)throw Error('Isolated baseline database mismatch')
  const scratch=await mkdtemp(join(tmpdir(),'figtree-p2-layout-before-')),fixture=join(scratch,'fixture.json')
  const env={...process.env,...config,P1_BROWSER_FIXTURE:fixture,NODE_OPTIONS:'--conditions=react-server'}
  const seed=spawnSync('npm',['run','db:verify-p1'],{env,encoding:'utf8',maxBuffer:16e6})
  await writeFile(join(evidence,'layout-before-seed.log'),seed.stdout+seed.stderr)
  if(seed.status!==0)throw Error('Baseline seed suite failed')
  const f=JSON.parse(await readFile(fixture,'utf8'))
  for(const part of ['src','public','package.json','tsconfig.json','next.config.ts','postcss.config.mjs','next-env.d.ts','node_modules'])await cp(join(root,part),join(scratch,part),{recursive:true,mode:constants.COPYFILE_FICLONE})
  const runtime:NodeJS.ProcessEnv={...env,DATABASE_URL:config.TEST_DATABASE_URL,NODE_OPTIONS:'',NODE_ENV:'production'}
  const bin=join(scratch,'node_modules/next/dist/bin/next'),built=spawnSync('node',[bin,'build'],{cwd:scratch,env:runtime,encoding:'utf8',maxBuffer:16e6})
  await writeFile(join(evidence,'layout-before-build.log'),built.stdout+built.stderr)
  if(built.status!==0)throw Error('Baseline production build failed')
  const socket=createServer();await new Promise<void>(r=>socket.listen(0,'127.0.0.1',r));const port=(socket.address() as {port:number}).port;await new Promise<void>(r=>socket.close(()=>r()))
  const server=spawn('node',[bin,'start','--hostname','127.0.0.1','--port',String(port)],{cwd:scratch,env:runtime,stdio:'ignore'})
  const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}}),base=`http://127.0.0.1:${port}`
  try {
    for(let n=0;n<120;n++){try{if((await fetch(base+'/login')).ok)break}catch{}if(n===119)throw Error('Baseline server readiness failed');await new Promise(r=>setTimeout(r,500))}
    await page.goto(base+'/login');await page.getByLabel('Email',{exact:true}).fill(f.email);await page.getByLabel('Password',{exact:true}).fill(f.password);await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.waitForURL(u=>!u.pathname.startsWith('/login'),{timeout:60000})
    const results=[]
    for(const width of [1440,900]) {
      console.log('Measuring baseline width '+width);await page.setViewportSize({width,height:1000});await page.goto(base+`/ledger/${f.ledgerId}/invoices/${f.invoiceId}/edit`)
      await page.waitForFunction(()=>!!(document.querySelector('input[name="editToken"]') as HTMLInputElement)?.value)
      results.push({width,path:'invoice/edit',elements:await page.evaluate(()=>Array.from(document.querySelectorAll('main h1,main input:not([type="hidden"]),[data-edit-protection],nav,a[href]')).map(e=>{const r=e.getBoundingClientRect();return {tag:e.tagName,name:e.getAttribute('name'),text:e.textContent?.slice(0,80),x:r.x,y:r.y,width:r.width,height:r.height}}))})
      await page.screenshot({path:join(evidence,`layout-before-${width}.png`),fullPage:true});await page.getByRole('button',{name:'Stop editing',exact:true}).click();await page.getByText('Editing stopped').first().waitFor()
    }
    await writeFile(join(evidence,'layout-before.json'),JSON.stringify({at:new Date().toISOString(),scope:'Before adding P2 workspace/navigation; P1 Compare-saved link was already generalized without CSS changes.',measurements:results},null,2)+'\n')
    console.log('PASS P2 real DOM layout baseline captured at 1440 and 900 pixels')
  } finally {await browser.close();server.kill('SIGTERM')}
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e instanceof Error?e.message:String(e));process.exit(1)})
