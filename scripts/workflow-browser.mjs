import {chromium,expect} from '@playwright/test'
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {join} from 'node:path'
const out=join(process.cwd(),'docs/evidence/workflow-placement-2026-10-09'),mode=process.argv[2]??'before',origin=process.env.WORKFLOW_ORIGIN??'http://localhost:3000'
const pointer=JSON.parse(await readFile('docs/evidence/ui-completion-2026-10-08/fixture.json','utf8')),f=JSON.parse(await readFile(pointer.privatePath,'utf8'))
const browser=await chromium.launch({headless:true}),ctx=await browser.newContext({viewport:{width:1440,height:1000}})
await ctx.addCookies([{name:'erp_session',value:f.token,domain:'localhost',path:'/',httpOnly:true,sameSite:'Lax'}])
const page=await ctx.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message))
await mkdir(join(out,'screens'),{recursive:true})
const L='/ledger/'+f.ledgerId,results=[]
const pages=[['income',L+'/income'],['party',L+'/parties/'+f.partyId],['ai',L+'/readings'],['settings','/settings?ledger='+f.ledgerId],['jobs',L+'/automation/jobs']]
try{for(const [name,path] of pages){await page.goto(origin+path,{waitUntil:'domcontentloaded'});await expect(page.locator('main[aria-busy=true]')).toHaveCount(0,{timeout:20000});await expect(page.locator('main')).toBeVisible();const result=await page.evaluate(()=>{
  const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}}
  const m=document.querySelector('main');return {title:document.title,path:location.pathname,overflow:document.documentElement.scrollWidth>innerWidth,main:m?rect(m):null,heading:[...document.querySelectorAll('h1,h2')].map(e=>({text:e.textContent,rect:rect(e)})),controls:[...document.querySelectorAll('main button,main input,main select,main a')].map(e=>({tag:e.tagName,text:e.getAttribute('aria-label')||e.textContent?.trim()||e.getAttribute('name'),rect:rect(e)}))}
});results.push({name,...result});await page.screenshot({path:join(out,'screens',mode+'-'+name+'-1440.png'),fullPage:true})}
await writeFile(join(out,'layout-'+mode+'.json'),JSON.stringify({results,errors},null,2)+'\n');console.log(mode,'views',results.length,'runtime errors',errors.length,'overflows',results.filter(x=>x.overflow).length)
}finally{await browser.close()}
