import {chromium} from '@playwright/test'
import {readFile,writeFile,mkdtemp,cp,constants} from 'node:fs/promises'
import {spawn,spawnSync} from 'node:child_process'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {parse} from 'dotenv'
async function main(){
  const phase=process.argv[2];if(!['before','after','before-master'].includes(phase))throw Error('Choose before/after/before-master')
  const proof=JSON.parse(await readFile('docs/evidence/p6/isolation.json','utf8')),config=parse(await readFile(proof.environmentPath))
  if(!proof.createdNew||proof.productionTouched||new URL(config.DATABASE_URL).pathname.slice(1)!==proof.applicationDatabase)throw Error('Unconfirmed APP')
  const f=JSON.parse(await readFile(proof.browserFixturePath,'utf8')),scratch=await mkdtemp(join(tmpdir(),'figtree-p6-layout-'))
  for(const p of ['src','public','package.json','tsconfig.json','next.config.ts','postcss.config.mjs','next-env.d.ts','node_modules'])
    await cp(p,join(scratch,p),{recursive:true,mode:constants.COPYFILE_FICLONE})
  const env:NodeJS.ProcessEnv={...process.env,...config,NODE_OPTIONS:'',NODE_ENV:'production'},bin=join(scratch,'node_modules/next/dist/bin/next')
  const built=spawnSync('node',[bin,'build','--webpack'],{cwd:scratch,env,encoding:'utf8',maxBuffer:24e6})
  await writeFile(`docs/evidence/p6/layout-${phase}-build.log`,built.stdout+built.stderr)
  if(built.status!==0)throw Error('Layout build failed')
  const server=spawn('node',[bin,'start','--hostname','127.0.0.1','--port','3096'],{cwd:scratch,env,stdio:'ignore'})
  const browser=await chromium.launch({headless:true}),context=await browser.newContext(),page=await context.newPage()
  try {
    for(let n=0;n<120;n++){try{if((await fetch('http://localhost:3096/login')).ok)break}catch{}if(n===119)throw Error('Readiness failed');await new Promise(r=>setTimeout(r,500))}
    await context.addCookies([{name:'erp_session',value:f.token,domain:'localhost',path:'/'}])
    const records=[]
    const masters=[`/ledger/${f.ledgerId}/accounts/${f.accountId}`,`/ledger/${f.ledgerId}/parties/${f.partyId}`]
    const paths=phase==='before-master'?masters:phase==='after'?['/settings/security','/audit',...masters]:['/settings/security','/audit']
    for(const width of [1440,900,390])for(const path of paths) {
      await page.setViewportSize({width,height:1000});await page.goto('http://localhost:3096'+path)
      await page.locator('main h1').waitFor()
      if(path.includes('/accounts/'))await page.getByRole('button',{name:'Edit this account',exact:true}).click()
      const record=await page.evaluate(()=>({pageWidth:innerWidth,scrollWidth:document.documentElement.scrollWidth,
        elements:Array.from(document.querySelectorAll('main h1,main form,main input:not([type="hidden"]),main button,main section')).map(e=>{
          const r=e.getBoundingClientRect();return {tag:e.tagName,name:e.getAttribute('name'),text:e.textContent?.slice(0,100),x:r.x,y:r.y,width:r.width,height:r.height}
        })}))
      records.push({width,path,...record})
      const seat=path==='/audit'?'audit':path.includes('/accounts/')?'account':path.includes('/parties/')?'party':'security'
      await page.screenshot({path:`docs/evidence/p6/layout-${phase}-${seat}-${width}.png`,fullPage:true})
    }
    await writeFile(`docs/evidence/p6/layout-${phase}.json`,JSON.stringify({at:new Date().toISOString(),records},null,2)+'\n')
    console.log('PASS real DOM measurement and screenshot captured: '+phase)
  }finally{await browser.close();server.kill('SIGTERM')}
}
main().catch(e=>{console.error(e instanceof Error?e.message:'Layout failed');process.exitCode=1})
