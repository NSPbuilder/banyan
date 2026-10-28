import './dotenv'
import {cp,mkdtemp,readFile,writeFile,symlink,rm,mkdir} from 'node:fs/promises'
import {spawnSync} from 'node:child_process'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
const cases=[
  {title:'Raw Stripe signature discarded',label:'P5C02',file:'src/lib/payment-provider.ts',before:"Stripe.webhooks.constructEvent(body,signature,openIntegration(c.webhook_ciphertext,c.id,'stripe-webhook'),300)",after:'JSON.parse(body.toString())'},
  {title:'Actual mode consistency discarded',label:'P5B03',file:'src/lib/online-payment-types.ts',before:"session.livemode!==(c.mode==='live')||pi.livemode!==session.livemode||charge.livemode!==session.livemode",after:'false'},
  {title:'Corrected invoice fingerprint discarded',label:'P5B22',file:'src/lib/processor-ledger.ts',before:'i.version!==r.invoice_version&&(!r.invoice_fingerprint||fingerprint.value!==r.invoice_fingerprint)',after:'false'},
  {title:'Fee expense redirected to clearing',label:'P5B11',file:'src/lib/processor-ledger.ts',before:'let debit=c.fee_account_id,partyId:string|undefined,refundFee=0n',after:'let debit=c.clearing_account_id,partyId:string|undefined,refundFee=0n'},
  {title:'Invitation secret ignored',label:'P5A06',file:'src/lib/customer-portal.ts',before:'AND token_hash=${tokenHash(token)}`)).length',after:'AND TRUE`)).length'},
  {title:'Recipient alias authorization ignored',label:'P5D02',file:'src/lib/inbound-mail.ts',before:'p.OriginalRecipient.toLowerCase()!==c.alias_address.toLowerCase()',after:'false'},
  {title:'Shared attachment duplicate flag suppressed',label:'P5D06',file:'src/lib/inbox.ts',before:"${same.length?'An identical file is already in this ledger. Review or link the existing accounting.':null}",after:'${null}'},
  {title:'Executable credential exported',label:'P5E01',file:'src/lib/backup.ts',before:'key_ciphertext:null,webhook_ciphertext:null,enabled:false,verified_at:null,binding_attached:false',after:'key_ciphertext:row.key_ciphertext,webhook_ciphertext:null,enabled:false,verified_at:null,binding_attached:false'},
  {title:'Current mapped account classification ignored',label:'P5B33',file:'src/lib/payment-provider.ts',before:'a.account_type===type',after:'true'},
]
async function main(){
  const proof=JSON.parse(await readFile('docs/evidence/p5/isolation.json','utf8')),target=process.env.TEST_DATABASE_URL,name=target?new URL(target).pathname.slice(1):''
  if(!proof.createdNew||proof.productionTouched||name!==proof.testDatabase||process.env.TEST_DATABASE_CONFIRMATION!==name)throw Error('Unconfirmed P5 mutation database')
  const root=process.cwd(),scratch=await mkdtemp(join(tmpdir(),'figtree-p5-mutations-')),evidence=join(root,'docs/evidence/p5'),originals=new Map<string,string>()
  for(const c of cases)originals.set(c.file,await readFile(join(root,c.file),'utf8'))
  const rows:Record<string,unknown>[]=[],report=['# P5 guard discrimination','','Actual PostgreSQL and production commands in a disposable source copy. No vendor API success is fabricated.','']
  let failures=0
  try{
    for(const part of ['src','db','scripts','package.json','tsconfig.json'])await cp(join(root,part),join(scratch,part),{recursive:true})
    await mkdir(join(scratch,'docs/evidence/p5'),{recursive:true});await cp(join(root,'docs/evidence/p5/isolation.json'),join(scratch,'docs/evidence/p5/isolation.json'))
    await symlink(join(root,'node_modules'),join(scratch,'node_modules'),'dir')
    const run=()=>spawnSync('npm',['run','db:verify-p5'],{cwd:scratch,env:{...process.env,NODE_OPTIONS:'--conditions=react-server'},encoding:'utf8',maxBuffer:16e6})
    const baseline=run();await writeFile(join(evidence,'mutation-baseline.log'),baseline.stdout+baseline.stderr)
    if(baseline.status!==0||!baseline.stdout.includes('=== ALL CHECKS PASSED ==='))throw Error('Mutation baseline failed')
    for(let i=0;i<cases.length;i++){
      for(const[file,source]of originals)await writeFile(join(scratch,file),source)
      const c=cases[i],source=originals.get(c.file)!
      if(source.split(c.before).length!==2)throw Error('Mutation anchor is not unique: '+c.title)
      await writeFile(join(scratch,c.file),source.replace(c.before,c.after))
      const result=run(),output=result.stdout+result.stderr,log='mutation-'+(i+1)+'.log'
      await writeFile(join(evidence,log),output)
      const lines=output.split('\n').filter(line=>line.startsWith('FAIL')&&line.includes(c.label)),proven=result.status!==0&&lines.length>0
      if(!proven)failures++
      console.log(`${proven?'PASS':'FAIL'} P5MU${i+1} ${c.title}`)
      rows.push({title:c.title,targetAssertion:c.label,exit:result.status,proven,failedLines:lines,log})
      report.push(`## P5MU${i+1}: ${c.title}`,'',`Exit ${result.status}; ${proven?'expected assertion failed':'NOT PROVEN'}. [Actual output](${log}).`,'','```text',...lines,'```','')
    }
    for(const[file,source]of originals)if(await readFile(join(root,file),'utf8')!==source)throw Error('Shared source bytes changed during mutation: '+file)
    report.push(`${cases.length-failures}/${cases.length} expected failures observed. Shared source bytes unchanged.`)
    await writeFile(join(evidence,'mutations.md'),report.join('\n')+'\n');await writeFile(join(evidence,'mutations.json'),JSON.stringify({baselineExit:baseline.status,cases:rows,sharedSourceUnchanged:true},null,2)+'\n')
    console.log(failures?'=== DISCRIMINATION FAILED ===':'=== ALL CHECKS PASSED ===');process.exitCode=failures?1:0
  }finally{await rm(scratch,{recursive:true,force:true})}
}
main().catch(e=>{console.error(e instanceof Error?e.message:'P5 discrimination failed');process.exitCode=1})
