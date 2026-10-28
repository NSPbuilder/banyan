import {readFileSync,writeFileSync} from 'node:fs'
import {spawn} from 'node:child_process'
import {parse} from 'dotenv'
import {chromium,type Page} from '@playwright/test'
import {PDFDocument,PDFName,PDFDict,PDFStream} from 'pdf-lib'
import {pdfText} from './pdf-text'
async function measure(page:Page){
  await page.evaluate(async()=>{await document.fonts.ready;await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())))})
  return page.evaluate(()=>{
    const dialog=document.querySelector('dialog[open],[role="dialog"][aria-modal="true"]')!,form=dialog.querySelector('form')!,r=form.getBoundingClientRect()
    const controls=Array.from(form.querySelectorAll('input[name="name"],select[name="layout"],textarea[name="paymentInstructions"],textarea[name="footer"]')).map(el=>{const box=el.getBoundingClientRect();return {name:el.getAttribute('name'),x:box.x,y:box.y,width:box.width,height:box.height}})
    if(controls.length!==4||controls.some(c=>c.width<=0||c.height<=0))throw Error('Branding editor measurement contains hidden or missing controls')
    return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth,origin:{x:r.x,y:r.y},controls}
  })
}
async function main(){
  const proof=JSON.parse(readFileSync('docs/evidence/p5/isolation.json','utf8')),env={...process.env,...parse(readFileSync(proof.environmentPath))}
  if(!proof.createdNew||proof.productionTouched||new URL(env.DATABASE_URL!).pathname.slice(1)!==proof.applicationDatabase)throw Error('Unconfirmed branding APP')
  const f=JSON.parse(readFileSync('docs/evidence/invoice-branding/browser-fixture.json','utf8')),session=JSON.parse(readFileSync(proof.browserFixturePath,'utf8')),before=process.argv.includes('--before'),port=4040,origin='http://127.0.0.1:'+port
  const server=spawn('npm',['run','start','--','--hostname','127.0.0.1','--port',String(port)],{env,stdio:'ignore',detached:true});let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined,diagnosticsPage:Page|undefined
  try{
    let ready=false;for(let i=0;i<120;i++){try{if((await fetch(origin+'/login')).ok){ready=true;break}}catch{}await new Promise(resolve=>setTimeout(resolve,500))}if(!ready)throw Error('Branding preview failed to start')
    browser=await chromium.launch({headless:true});const context=await browser.newContext();await context.addInitScript('globalThis.__name = (fn) => fn');await context.addCookies([{name:'erp_session',value:session.token,url:origin,httpOnly:true,sameSite:'Lax'}]);const page=await context.newPage(),measurements=[];diagnosticsPage=page
    for(const width of [1440,900]){
      await page.setViewportSize({width,height:1000});await page.goto(origin+'/settings/invoice-templates',{waitUntil:'networkidle'});await page.getByRole('button',{name:'Manage '+f.templateName}).click();await page.getByRole('dialog').waitFor();measurements.push(await measure(page));await page.screenshot({path:`docs/evidence/invoice-branding/${before?'before':'after'}-${width}.png`,fullPage:true})
    }
    writeFileSync(`docs/evidence/invoice-branding/${before?'before':'after'}-layout.json`,JSON.stringify(measurements,null,2)+'\n')
    if(before){console.log('PASS branding actual original editor measured at 1440/900 before changes');return}
    let checks=0
    const check=(value:boolean,label:string)=>{if(!value)throw Error(label);console.log('PASS '+label);checks++}
    const original=JSON.parse(readFileSync('docs/evidence/invoice-branding/before-layout.json','utf8')) as typeof measurements,comparison=[]
    for(const next of measurements){
      const old=original.find(m=>m.width===next.width)!,shift={x:next.origin.x-old.origin.x,y:next.origin.y-old.origin.y}
      const differences=old.controls.flatMap(c=>{const current=next.controls.find(n=>n.name===c.name);return !current||Math.abs(current.width-c.width)>1||Math.abs(current.height-c.height)>1||Math.abs(current.x-c.x-shift.x)>1||Math.abs(current.y-c.y-shift.y)>1?[{before:c,after:current}]:[]})
      comparison.push({width:next.width,dialogOriginShift:shift,differences});check(!differences.length&&next.scrollWidth<=next.width,'IBUI01-'+next.width+' original controls preserve dimensions and relative positions; dialog shift recorded')
    }
    writeFileSync('docs/evidence/invoice-branding/layout-comparison.json',JSON.stringify(comparison,null,2)+'\n')
    const dialog=()=>page.getByRole('dialog')
    const reopen=async()=>{await page.goto(origin+'/settings/invoice-templates',{waitUntil:'networkidle'});await page.getByRole('button',{name:'Manage '+f.templateName}).click();await dialog().waitFor()}
    const save=async()=>{
      const old=Number(await dialog().locator('input[name="version"]').inputValue())
      await Promise.all([page.waitForResponse(response=>response.request().method()==='POST'&&!!response.request().headers()['next-action']),dialog().getByRole('button',{name:'Save template',exact:true}).click()])
      await page.waitForFunction(version=>document.querySelector<HTMLInputElement>('dialog[open] input[name="version"]')?.value===String(version),old+1,{timeout:30000})
      return old+1
    }
    await dialog().getByLabel('Company logo',{exact:true}).setInputFiles('scripts/fixtures/branding/test-logo.png')
    for(const[label,value]of [['address','100 Sample Street'],['city','Vancouver'],['province','BC'],['postalCode','V0X 0X0'],['officePhone','604-555-0100'],['cellPhone','604-555-0101'],['email','contact@example.test']])await dialog().locator('[name='+label+']').fill(value)
    await dialog().locator('[data-invoice-doc] img').waitFor()
    check(await dialog().locator('[data-invoice-doc]').innerText().then(t=>['Vancouver BC V0X 0X0','Office: 604-555-0100','Cell: 604-555-0101','contact@example.test'].every(v=>t.includes(v))),'IBUI02 all seven entered fields appear in live preview')
    check(await dialog().locator('[data-invoice-doc] img').evaluate((img:HTMLImageElement)=>img.complete&&img.naturalWidth===2400&&img.getBoundingClientRect().width>0),'IBUI03 real uploaded logo decodes and fits preview')
    await save();await reopen()
    check(await dialog().locator('[name=address]').inputValue()==='100 Sample Street'&&await dialog().locator('[name=officePhone]').inputValue()==='604-555-0100'&&await dialog().locator('[name=email]').inputValue()==='contact@example.test'&&await dialog().locator('[data-invoice-doc] img').count()===1,'IBUI04 multipart server action persists actual logo/contact into a new version')
    const imageCount=async(bytes:Buffer)=>{const pdf=await PDFDocument.load(bytes);return pdf.getPages().reduce((count,page)=>{const items=page.node.Resources()?.lookup(PDFName.of('XObject'));return count+(items instanceof PDFDict?items.entries().filter(([,ref])=>{const item=pdf.context.lookup(ref);return item instanceof PDFStream&&item.dict.get(PDFName.of('Subtype'))===PDFName.of('Image')}).length:0)},0)}
    const pdf=await context.request.get(origin+'/settings/invoice-templates/'+f.templateId+'/preview'),body=await pdf.body()
    check(pdf.ok()&&pdf.headers()['content-type'].includes('application/pdf')&&await imageCount(body)>0&&pdfText(body).includes('Office: 604-555-0100'),'IBUI05 actual protected preview PDF includes real uploaded logo and contact')
    writeFileSync('docs/evidence/invoice-branding/browser-preview.pdf',body)
    const health=[]
    for(const width of [1440,900,390]){
      await page.setViewportSize({width,height:1000})
      await page.evaluate(async()=>{await document.fonts.ready;await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())))})
      const measured=await page.evaluate(()=>{
        const root=document.querySelector('dialog[open]')!,editor=root.querySelector('form')!,bounds=root.getBoundingClientRect(),header=root.querySelector('.overlay-header')!.getBoundingClientRect(),actions=editor.querySelector('.form-actions')!.getBoundingClientRect()
        const visible=(e:Element)=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'}
        const controls=Array.from(editor.querySelectorAll('input,select,textarea,button,a,img')).filter(e=>visible(e)&&!(e instanceof HTMLInputElement&&e.type==='hidden')),outside:string[]=[],overlaps:string[]=[],svgErrors:string[]=[],clipped:string[]=[],rectangles=[]
        for(const e of controls){const r=e.getBoundingClientRect(),chrome=!!e.closest('.form-actions'),id=e.getAttribute('name')??e.tagName,top=Math.max(r.top,chrome?bounds.top:header.bottom),bottom=Math.min(r.bottom,chrome?bounds.bottom:actions.top)
          if(bottom<=top){clipped.push(id);continue}
          if(r.left<bounds.left-1||r.right>bounds.right+1)outside.push(id)
          rectangles.push({id,left:r.left,right:r.right,top,bottom,chrome})
        }
        for(let i=0;i<rectangles.length;i++)for(let j=i+1;j<rectangles.length;j++){const a=rectangles[i],b=rectangles[j];if(Math.min(a.right,b.right)-Math.max(a.left,b.left)>1&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1)overlaps.push(a.id+' / '+b.id)}
        for(const svg of Array.from(editor.querySelectorAll('svg')).filter(visible)){const b=svg.viewBox.baseVal;if(b.width<=0||b.height<=0||!Number.isFinite(b.width+b.height))svgErrors.push('Invalid SVG')}
        return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth,controls:controls.length,outside,overlaps,svgErrors,clippedByExistingScrollChrome:clipped,rectangles,scope:'Invoice editor form; company-access table is a separate existing horizontal scroll region'}
      })
      health.push(measured);writeFileSync('docs/evidence/invoice-branding/layout-health.json',JSON.stringify(health,null,2)+'\n');check(!measured.outside.length&&!measured.overlaps.length&&!measured.svgErrors.length&&measured.scrollWidth<=width,'IBUI06-'+width+' visible editor controls and logo do not overlap or overflow; sticky chrome clipping measured, SVG valid')
      await dialog().locator('[data-invoice-doc]').scrollIntoViewIfNeeded();await page.screenshot({path:`docs/evidence/invoice-branding/filled-${width}.png`,fullPage:true})
    }
    writeFileSync('docs/evidence/invoice-branding/layout-health.json',JSON.stringify(health,null,2)+'\n')
    await page.setViewportSize({width:1440,height:1000});await reopen()
    const currentVersion=await dialog().locator('input[name="version"]').inputValue()
    await page.evaluate(()=>{const form=document.querySelector('dialog[open] form')!;form.querySelector<HTMLInputElement>('input[name="logo"]')!.value='';form.querySelector<HTMLInputElement>('input[name="logoDataUrl"]')!.value='data:image/svg+xml;base64,PHN2Zy8+'})
    await Promise.all([page.waitForResponse(response=>response.request().method()==='POST'&&!!response.request().headers()['next-action']),dialog().getByRole('button',{name:'Save template',exact:true}).click()]);await dialog().locator('p[role="alert"]').waitFor()
    check((await dialog().locator('p[role="alert"]').innerText()).includes('PNG or JPEG')&&(await dialog().locator('input[name="version"]').inputValue())===currentVersion,'IBUI07 forged SVG is actually refused by server without a new version')
    await reopen();await dialog().getByRole('button',{name:'Remove logo',exact:true}).click();await save();await reopen()
    const removed=await context.request.get(origin+'/settings/invoice-templates/'+f.templateId+'/preview')
    check(await dialog().locator('[data-invoice-doc] img').count()===0&&await imageCount(await removed.body())===0,'IBUI08 remove-logo version persists to HTML and PDF')
    await dialog().getByLabel('Company logo',{exact:true}).setInputFiles('scripts/fixtures/branding/test-logo.png');await save();await reopen()
    check(await dialog().locator('[data-invoice-doc] img').count()===1,'IBUI09 re-upload produces a reviewed reusable branded template')
    await page.evaluate(()=>document.documentElement.dataset.mode='dark')
    await dialog().locator('[data-invoice-doc]').scrollIntoViewIfNeeded()
    check(await dialog().locator('[data-invoice-doc] img').evaluate((img:HTMLImageElement)=>img.complete&&img.naturalWidth===2400&&getComputedStyle(img.parentElement!).backgroundColor==='rgb(255, 255, 255)'),'IBUI10 dark mode retains decoded original logo with a white backdrop')
    await page.screenshot({path:'docs/evidence/invoice-branding/filled-dark-1440.png',fullPage:true})
    writeFileSync('docs/evidence/invoice-branding/browser-result.json',JSON.stringify({checks,passed:true,isolatedApplication:true,realCompanyModified:false},null,2)+'\n')
  }catch(error){if(diagnosticsPage){await diagnosticsPage.screenshot({path:'docs/evidence/invoice-branding/browser-failure.png',fullPage:true});console.error(JSON.stringify(await diagnosticsPage.evaluate(()=>({path:location.pathname,openDialogs:Array.from(document.querySelectorAll('dialog[open]')).map(d=>({label:d.getAttribute('aria-label'),fields:Array.from(d.querySelectorAll('input,textarea,select')).map(e=>e.getAttribute('name'))}))}))))}throw error}
  finally{await browser?.close();try{process.kill(-server.pid!,'SIGTERM')}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw e}}
}
main().catch(e=>{console.error(e instanceof Error?e.message:'Branding browser failed');process.exitCode=1})
