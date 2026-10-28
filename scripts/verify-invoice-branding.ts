import './env'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {randomBytes} from 'node:crypto'
import {sql} from 'drizzle-orm'
import {PDFDocument,PDFName,PDFDict,PDFStream} from 'pdf-lib'
import {db,sql as connection} from '../src/db/client'
import {reporter,errorText} from './suite'
import {pdfText} from './pdf-text'
import {createFirstOwner} from '../src/lib/users'
import {createCompany,createFiscalYear} from '../src/lib/setup'
import {importAccounts,parseAccountsCsv} from '../src/lib/accounts'
import {createParty} from '../src/lib/parties'
import {createInvoice,postInvoice} from '../src/lib/invoices'
import {createInvoiceTemplate,allInvoiceTemplates,reviseInvoiceTemplate,setInvoiceTemplateAssignment} from '../src/lib/invoice-templates'
import {STANDARD_INVOICE_SETTINGS,invoiceContactLines,type InvoiceTemplateSettings} from '../src/lib/invoice-template-types'
import {parseInvoiceLogo} from '../src/lib/invoice-branding'
import {renderInvoiceDocument} from '../src/lib/customer-docs'
import {invoicePdf} from '../src/lib/pdf-reports'
import {exportCompany,restoreCompany} from '../src/lib/backup'
const r=reporter(97)
async function main(){
  const name=new URL(process.env.DATABASE_URL!).pathname.slice(1),proof=JSON.parse(readFileSync(process.env.FIGTREE_TEST_ISOLATION_PROOF??(name.startsWith('figtree_p6_')?'docs/evidence/p6/isolation.json':'docs/evidence/p5/isolation.json'),'utf8'))
  if(process.env.TEST_DATABASE_CONFIRMATION!==name||(!(process.env.CI==='true'&&name==='figtree_ci_test')&&(!proof.createdNew||proof.productionTouched||name!==proof.testDatabase)))throw Error('Unconfirmed branding TEST')
  const bytes=readFileSync('scripts/fixtures/branding/test-logo.png'),logoDataUrl='data:image/png;base64,'+bytes.toString('base64'),logo=await parseInvoiceLogo(logoDataUrl)
  r.check(logo!==null&&logo.bytes.equals(bytes)&&logo.width===2400&&logo.height>390&&logo.height<410,'IB01 bundled synthetic public artwork is a 2400px PNG')
  const me=await createFirstOwner({email:'branding@example.test',password:randomBytes(30).toString('base64url'),firstName:'Branding test'}),co=await createCompany({code:'BRANDTEST',name:'VIEWMAX (isolated template sample)'},me.email)
  await createFiscalYear(co.ledger.id,'2026-12-31',me.email)
  const accounts=await importAccounts(co.company.id,parseAccountsCsv('1200,Receivables,asset,,trade_receivables\n4000,Revenue,revenue,,revenue_from_contracts').map(a=>({...a,entityId:co.company.id})),me.email),account=(code:string)=>accounts.find(a=>a.code===code)!.id
  const party=await createParty({kind:'organisation',name:'Sample customer',notes:'Internal Party note must never appear on invoice',
    primaryContact:{name:'Pat Customer',email:'customer@example.test',phone:'604-555-0123'},
    mailingAddress:{line1:'125 Customer Street',line2:'Suite 400',city:'Vancouver',region:'BC',postalCode:'V6B 1A1',country:'CA'},
    roles:[{entityId:co.company.id,role:'customer'}],actor:me.email})
  const contact={address:' 100 Sample Street ',city:' Vancouver ',province:' BC ',postalCode:' V0X 0X0 ',officePhone:' 604-555-0100 ',cellPhone:' 604-555-0101 ',email:' contact@example.test '}
  const settings:InvoiceTemplateSettings={...STANDARD_INVOICE_SETTINGS,logoDataUrl,contact,footer:'SAMPLE ONLY. Enter your real address and contact details in template settings.'}
  const no=async(label:string,input:InvoiceTemplateSettings,code:string,contains?:string)=>{try{await createInvoiceTemplate(me,{entityId:co.company.id,name:'Rejected '+label,settings:input});r.check(false,label)}catch(e){r.check((e as {code?:string}).code===code&&(!contains||errorText(e).includes(contains)),label)}}
  await no('IB02 external logo URL refused',{...settings,logoDataUrl:'https://example.test/logo.png'},'BAD_LOGO')
  await no('IB03 SVG logo cannot introduce active content',{...settings,logoDataUrl:'data:image/svg+xml;base64,'+Buffer.from('<svg onload="alert(1)"/>').toString('base64')},'BAD_LOGO')
  await no('IB04 image MIME cannot disguise arbitrary bytes',{...settings,logoDataUrl:'data:image/png;base64,'+Buffer.from('not an image').toString('base64')},'BAD_LOGO')
  const oversized=Buffer.concat([bytes,Buffer.alloc(262145-bytes.length)])
  await no('IB05 valid-image payload above 256 KB refused',{...settings,logoDataUrl:'data:image/png;base64,'+oversized.toString('base64')},'BAD_LOGO')
  const larger=readFileSync('scripts/fixtures/branding/logo-above-pixel-limit.png')
  await no('IB06 valid image above 2 megapixels refused',{...settings,logoDataUrl:'data:image/png;base64,'+larger.toString('base64')},'BAD_LOGO','2 megapixels')
  const giant=Buffer.from(bytes);giant.writeUInt32BE(50000,16);giant.writeUInt32BE(50000,20)
  await no('IB06a oversized PNG dimensions refused before decompression',{...settings,logoDataUrl:'data:image/png;base64,'+giant.toString('base64')},'BAD_LOGO','2 megapixels')
  await no('IB07 contact control characters refused',{...settings,contact:{...contact,city:'Vancouver\u0000hidden'}},'BAD_CONTACT')
  await no('IB08 malformed email refused by server',{...settings,contact:{...contact,email:'not an email'}},'BAD_CONTACT')
  const id=await createInvoiceTemplate(me,{entityId:co.company.id,name:'VIEWMAX sample branding',settings}),saved=(await allInvoiceTemplates(me)).find(t=>t.id===id)!
  r.check(saved.settings.logoDataUrl===logoDataUrl&&Object.keys(contact).every(k=>saved.settings.contact?.[k as keyof typeof contact]===contact[k as keyof typeof contact].trim()),'IB09 actual template stores logo and all seven normalized contact fields')
  await setInvoiceTemplateAssignment(me,{ledgerId:co.ledger.id,templateId:id})
  const make=async(number:string)=>{const i=await createInvoice({ledgerId:co.ledger.id,direction:'sales',partyId:party.id,controlAccountId:account('1200'),issuedOn:'2026-10-01',dueOn:'2026-10-31',number,lines:[{accountId:account('4000'),amount:-125000n,description:'Professional services (sample)'}],actor:me.email});await postInvoice(i.id,me.email);return i.id}
  const first=await make('BRAND-SAMPLE-001'),doc=await renderInvoiceDocument(first)
  r.check(doc.template?.version===1&&doc.template.settings.logoDataUrl===logoDataUrl&&doc.company.name===co.company.name&&doc.total===125000n,'IB10 controlled posting freezes branding while company name and exact amount come from books')
  const paper=await invoicePdf(first),text=pdfText(paper.buffer),pdf=await PDFDocument.load(paper.buffer)
  const hasImage=(d:PDFDocument)=>d.getPages().some(page=>{const objects=page.node.Resources()?.lookup(PDFName.of('XObject'));return objects instanceof PDFDict&&objects.entries().some(([,ref])=>{const item=d.context.lookup(ref);return item instanceof PDFStream&&item.dict.get(PDFName.of('Subtype'))===PDFName.of('Image')})})
  r.check(['100 Sample Street','Vancouver BC V0X 0X0','Office: 604-555-0100','Cell: 604-555-0101','contact@example.test','1,250.00'].every(s=>text.includes(s)),'IB11 actual invoice PDF contains contact details and unchanged formatted money')
  r.check(hasImage(pdf),'IB12 actual invoice PDF embeds original logo image bytes as an image object')
  r.check(doc.billTo.addressLines.join('|')==='125 Customer Street|Suite 400|Vancouver BC V6B 1A1'
    &&doc.billTo.contactLines?.join('|')==='Attn: Pat Customer|customer@example.test|Phone: 604-555-0123'
    &&['125 Customer Street','Suite 400','Vancouver BC V6B 1A1','Attn: Pat Customer','customer@example.test','Phone: 604-555-0123'].every(value=>text.includes(value))
    &&!text.includes('Internal Party note must never appear on invoice')&&doc.total===125000n,
    'IB21 customer primary contact and address reach the shared invoice document and actual PDF without internal notes or money changes')
  mkdirSync('output/pdf',{recursive:true});writeFileSync('output/pdf/viewmax-invoice-branding-sample.pdf',paper.buffer)
  await reviseInvoiceTemplate(me,{templateId:id,version:1,name:'VIEWMAX sample branding',settings:{...settings,logoDataUrl:'',contact:{...contact,address:'200 New Sample Street',city:'New Sample City'}},isActive:true})
  const original=await renderInvoiceDocument(first),oldPaper=await invoicePdf(first)
  r.check(original.template?.version===1&&original.template.settings.logoDataUrl===logoDataUrl&&pdfText(oldPaper.buffer).includes('100 Sample Street')&&!pdfText(oldPaper.buffer).includes('200 New Sample Street'),'IB13 later logo removal and address revision leave posted branding unchanged')
  const second=await make('BRAND-SAMPLE-002'),newPaper=await invoicePdf(second)
  r.check((await renderInvoiceDocument(second)).template?.version===2&&pdfText(newPaper.buffer).includes('200 New Sample Street')&&!hasImage(await PDFDocument.load(newPaper.buffer)),'IB14 future invoices use revised contact and removed logo')
  try{await reviseInvoiceTemplate(me,{templateId:id,version:1,name:'Stale branding',settings,isActive:true});r.check(false,'IB15 stale version cannot overwrite branding')}catch(e){r.check((e as {code?:string}).code==='CONFLICT','IB15 stale version cannot overwrite branding')}
  r.check(invoiceContactLines(undefined,['Registered address']).join('|')==='Registered address'&&invoiceContactLines({...STANDARD_INVOICE_SETTINGS,contact:{address:'',city:'',province:'',postalCode:'',officePhone:'604-555-0111',cellPhone:'',email:''}},['Registered address']).join('|')==='Registered address|Office: 604-555-0111','IB16 blank location preserves existing registered address with optional contact')
  const portable=await exportCompany(co.company.id)
  r.check(portable.rows.invoice.some(i=>JSON.stringify(i.print_template_snapshot).includes(logoDataUrl)),'IB17 portable company snapshot retains self-contained logo without external attachment paths')
  const restored=await restoreCompany(portable,me.email,{code:'BRANDCOPY',name:'VIEWMAX branding restored sample'}),[restoredFirst]=await db.execute<{id:string}>(sql`SELECT id::text FROM invoice WHERE ledger_id=${restored.ledgerId}::uuid AND number='BRAND-SAMPLE-001'`),restoredPaper=await invoicePdf(restoredFirst.id)
  r.check(hasImage(await PDFDocument.load(restoredPaper.buffer))&&pdfText(restoredPaper.buffer).includes('100 Sample Street'),'IB18 actual company restore renders historical logo and address without shared-template grants')
  const legacy=await createInvoiceTemplate(me,{entityId:co.company.id,name:'Legacy settings',settings:STANDARD_INVOICE_SETTINGS}),plain=(await allInvoiceTemplates(me)).find(t=>t.id===legacy)!
  r.check(JSON.stringify(plain.settings)===JSON.stringify({footer:'',layout:'standard',paymentInstructions:''})||(!plain.settings.logoDataUrl&&!plain.settings.contact&&plain.settings.layout==='standard'),'IB19 existing three-field templates remain compatible without branding')
  const jpeg=readFileSync('scripts/fixtures/branding/logo-jpeg.jpg'),jpegDataUrl='data:image/jpeg;base64,'+jpeg.toString('base64')
  await reviseInvoiceTemplate(me,{templateId:id,version:2,name:'VIEWMAX sample branding',settings:{...settings,layout:'compact',logoDataUrl:jpegDataUrl},isActive:true})
  const third=await make('BRAND-SAMPLE-003'),jpegPaper=await invoicePdf(third),jpegDoc=await renderInvoiceDocument(third)
  r.check(jpegDoc.template?.version===3&&jpegDoc.template.settings.layout==='compact'&&jpegDoc.template.settings.logoDataUrl===jpegDataUrl&&hasImage(await PDFDocument.load(jpegPaper.buffer))&&pdfText(jpegPaper.buffer).includes('Office: 604-555-0100'),'IB20 actual JPEG logo saves, posts and renders in Compact layout')
}
main().catch(e=>{r.fail('IB execution',errorText(e));process.exitCode=1}).finally(async()=>{console.log(r.summary());if(r.failures)process.exitCode=1;await connection.end()})
