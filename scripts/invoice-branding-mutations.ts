import './dotenv'
import {cp,mkdtemp,readFile,writeFile,symlink,rm,mkdir} from 'node:fs/promises'
import {spawnSync} from 'node:child_process'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
const cases=[
  {title:'256 KB logo byte cap removed',label:'IB05',file:'src/lib/invoice-template-types.ts',before:'INVOICE_LOGO_MAX_BYTES = 256 * 1024',after:'INVOICE_LOGO_MAX_BYTES = 8 * 1024 * 1024',count:1},
  {title:'Both predecode and decoded 2 megapixel caps removed',label:'IB06 ',file:'src/lib/invoice-branding.ts',before:'2_000_000',after:'40_000_000',count:2},
  {title:'Contact email format guard removed',label:'IB08',file:'src/lib/invoice-branding.ts',before:'clean.email && !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(clean.email)',after:'false',count:1},
  {title:'Contact control-character guard removed',label:'IB07',file:'src/lib/invoice-branding.ts',before:'/['+String.fromCharCode(92)+'x00-'+String.fromCharCode(92)+'x09'+String.fromCharCode(92)+'x0b-'+String.fromCharCode(92)+'x1f'+String.fromCharCode(92)+'x7f]/.test(text)',after:'false',count:1},
  {title:'Saved contact omitted from posted snapshot',label:'IB11',file:'src/lib/invoice-templates.ts',before:'settings: template.settings }',after:'settings: {...template.settings, contact: undefined} }',count:1},
  {title:'Actual PDF logo image omitted',label:'IB12',file:'src/lib/invoice-pdf.ts',before:'const logo = await parseInvoiceLogo(invoice.template?.settings.logoDataUrl)',after:'const logo = null',count:1},
]
async function main(){
  const proof=JSON.parse(await readFile('docs/evidence/p5/isolation.json','utf8')),target=process.env.TEST_DATABASE_URL,name=target?new URL(target).pathname.slice(1):''
  if(!proof.createdNew||proof.productionTouched||name!==proof.testDatabase||process.env.TEST_DATABASE_CONFIRMATION!==name)throw Error('Unconfirmed invoice-branding mutation database')
  const root=process.cwd(),scratch=await mkdtemp(join(tmpdir(),'figtree-invoice-branding-mutations-')),evidence=join(root,'docs/evidence/invoice-branding'),originals=new Map<string,string>()
  for(const c of cases)originals.set(c.file,await readFile(join(root,c.file),'utf8'))
  const rows:Record<string,unknown>[]=[],report=['# Invoice branding guard discrimination','','Actual PostgreSQL and production commands in a disposable source copy. No application source is mutated in the shared workspace.','']
  let failures=0
  try{
    for(const part of ['src','db','scripts','package.json','tsconfig.json'])await cp(join(root,part),join(scratch,part),{recursive:true})
    await mkdir(join(scratch,'docs/evidence/p5'),{recursive:true});await cp(join(root,'docs/evidence/p5/isolation.json'),join(scratch,'docs/evidence/p5/isolation.json'))
    await mkdir(join(scratch,'scripts/fixtures/branding'),{recursive:true});for(const asset of ['logo-above-pixel-limit.png','logo-jpeg.jpg'])await cp(join(root,'scripts/fixtures/branding',asset),join(scratch,'scripts/fixtures/branding',asset));await mkdir(join(scratch,'scripts/fixtures/branding'),{recursive:true});await cp(join(root,'scripts/fixtures/branding/test-logo.png'),join(scratch,'scripts/fixtures/branding/test-logo.png'))
    await symlink(join(root,'node_modules'),join(scratch,'node_modules'),'dir')
    const run=()=>spawnSync('npm',['run','db:verify-invoice-branding'],{cwd:scratch,env:{...process.env,NODE_OPTIONS:'--conditions=react-server'},encoding:'utf8',maxBuffer:16e6})
    const baseline=run();await writeFile(join(evidence,'mutation-baseline.log'),baseline.stdout+baseline.stderr)
    if(baseline.status!==0||!baseline.stdout.includes('=== ALL CHECKS PASSED ==='))throw Error('Mutation baseline failed')
    for(let i=0;i<cases.length;i++){
      for(const[file,source]of originals)await writeFile(join(scratch,file),source)
      const c=cases[i],source=originals.get(c.file)!
      if(source.split(c.before).length!==c.count+1)throw Error('Mutation anchor is not unique: '+c.title)
      await writeFile(join(scratch,c.file),source.split(c.before).join(c.after))
      const result=run(),output=result.stdout+result.stderr,log='mutation-'+(i+1)+'.log'
      await writeFile(join(evidence,log),output)
      const lines=output.split('\n').filter(line=>line.startsWith('FAIL')&&line.includes(c.label)),proven=result.status!==0&&lines.length>0
      if(!proven)failures++
      console.log(`${proven?'PASS':'FAIL'} IBMU${i+1} ${c.title}`)
      rows.push({title:c.title,targetAssertion:c.label,exit:result.status,proven,failedLines:lines,log})
      report.push(`## IBMU${i+1}: ${c.title}`,'',`Exit ${result.status}; ${proven?'expected assertion failed':'NOT PROVEN'}. [Actual output](${log}).`,'','```text',...lines,'```','')
    }
    for(const[file,source]of originals)if(await readFile(join(root,file),'utf8')!==source)throw Error('Shared source bytes changed during mutation: '+file)
    report.push(`${cases.length-failures}/${cases.length} expected failures observed. Shared source bytes unchanged.`)
    await writeFile(join(evidence,'mutations.md'),report.join('\n')+'\n');await writeFile(join(evidence,'mutations.json'),JSON.stringify({baselineExit:baseline.status,cases:rows,sharedSourceUnchanged:true},null,2)+'\n')
    console.log(failures?'=== DISCRIMINATION FAILED ===':'=== ALL CHECKS PASSED ===');process.exitCode=failures?1:0
  }finally{await rm(scratch,{recursive:true,force:true})}
}
main().catch(e=>{console.error(e instanceof Error?e.message:'Branding discrimination failed');process.exitCode=1})
