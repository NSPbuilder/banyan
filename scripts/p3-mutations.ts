import './dotenv'
import { cp,mkdtemp,readFile,writeFile,symlink,rm,mkdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const cases=[
 {title:'Ordinary posting allowed during incomplete migration',label:'P3A02',migration:'DROP TRIGGER p3_migration_write_gate ON journal_entry; DROP TRIGGER p3_migration_write_gate ON journal_line;'},
 {title:'Approved source staging unfrozen',label:'P3A25',migration:'DROP TRIGGER p3_stage_owner ON migration_stage;'},
 {title:'Migration identity may change',label:'P3A26',migration:'DROP TRIGGER p3_run_scope ON migration_run;'},
 {title:'Source references may be removed',label:'P3A18',migration:'DROP TRIGGER p3_reference_scope ON migration_reference;'},
 {title:'Balance-sheet account permitted in budget',label:'P3B17',migration:'DROP TRIGGER p3_budget_line_scope ON budget_line;'},
 {title:'Published budget header editable',label:'P3B18',migration:'DROP TRIGGER p3_budget_scope ON budget;'},
 {title:'Complete source group count ignored',label:'P3H01',file:'src/lib/ledger-import.ts',before:"if(rows.length!==first.expectedLines||gl.some(g=>g.expectedLines!==rows.length||g.date!==first.date||g.documentType!==first.documentType||g.currency!==first.currency||g.sourceId!==first.sourceId||g.sourceGroup!==first.sourceGroup||g.number!==first.number||g.dueOn!==first.dueOn))",after:'if(false)'},
 {title:'Revenue actual debit/credit presentation inverted',label:'P3B01',file:'src/lib/budgets.ts',before:"f.account_type==='revenue'?-1n:1n",after:'1n'},
 {title:'Annual allocation loses cents',label:'P3B03',file:'src/lib/budget-types.ts',before:'allocate(total,Array(count).fill(1))',after:'Array(count).fill(total/BigInt(count))'},
 {title:'Source checkpoint inserted without controlled transaction',label:'P3A28',migration:'DROP TRIGGER p3_reference_scope ON migration_reference;'},
 {title:'Non-bank account accepted as outstanding bank item',label:'P3K01',file:'src/lib/ledger-import.ts',before:"if(!a?.roles.includes('cash_and_cash_equivalents'))",after:'if(false)'},
 {title:'Opening invoice aging loses original source date',label:'P3A29',file:'src/lib/aging.ts',before:'COALESCE(migration_source.original_date,cm.entry_date) AS entry_date',after:'cm.entry_date'},
 {title:'Identical starting/cutoff snapshots falsely refused',label:'P3H17',file:'src/lib/ledger-import.ts',before:"const snapshotPairs=[['starting_trial_balance','trial_balance'],['starting_open_items','open_items']]",after:'const snapshotPairs:string[][]=[]'},
]

async function main() {
  const target=process.env.TEST_DATABASE_URL,name=target?new URL(target).pathname.slice(1):''
  if(!target||process.env.TEST_DATABASE_CONFIRMATION!==name||!/^[a-z][a-z0-9_]*_test$/.test(name))throw Error('Unconfirmed P3 mutation database')
  const root=process.cwd(),scratch=await mkdtemp(join(tmpdir(),'figtree-p3-mutations-')),evidence=join(root,'docs/evidence/p3')
  await mkdir(evidence,{recursive:true});const originals=new Map<string,string>()
  for(const c of cases)if('file' in c&&c.file)originals.set(c.file,await readFile(join(root,c.file),'utf8'))
  const report=['# P3 guard discrimination','','Real PostgreSQL  cases run in a disposable source copy. No shared code is edited.',''];let failures=0
  try {
    for(const part of ['src','db','scripts','package.json','tsconfig.json'])await cp(join(root,part),join(scratch,part),{recursive:true})
    await symlink(join(root,'node_modules'),join(scratch,'node_modules'),'dir')
    await mkdir(join(scratch,'docs/evidence/p3'),{recursive:true})
    const run=()=>spawnSync('npm',['run','db:verify-p3'],{cwd:scratch,env:{...process.env,NODE_OPTIONS:'--conditions=react-server'},encoding:'utf8',maxBuffer:16e6})
    const baseline=run();await writeFile(join(evidence,'mutation-baseline.log'),baseline.stdout+baseline.stderr)
    if(baseline.status!==0||!baseline.stdout.includes('=== ALL CHECKS PASSED ==='))throw Error('P3 mutation baseline failed')
    report.push('Baseline: exit 0; all checks passed.','')
    for(let i=0;i<cases.length;i++) {
      for(const [file,source] of originals)await writeFile(join(scratch,file),source)
      await rm(join(scratch,'db/migrations/9999_p3_discrimination_only.sql'),{force:true})
      const c=cases[i]
      if('file' in c&&c.file){const source=originals.get(c.file)!;if(source.split(c.before!).length!==2)throw Error('Mutation anchor must be unique: '+c.title);await writeFile(join(scratch,c.file),source.replace(c.before!,c.after!))}
      else if('migration' in c)await writeFile(join(scratch,'db/migrations/9999_p3_discrimination_only.sql'),c.migration!)
      const result=run(),output=result.stdout+result.stderr,log=`mutation-${i+1}.log`
      await writeFile(join(evidence,log),output)
      const lines=output.split('\n').filter(line=>line.startsWith('FAIL')&&line.includes(c.label)),proven=result.status!==0&&lines.length>0
      if(!proven)failures++;console.log(`${proven?'PASS':'FAIL'} P3MU${i+1} ${c.title}`)
      report.push(`## P3MU${i+1}: ${c.title}`,'',`Exit ${result.status}; ${proven?'expected assertion failed':'NOT PROVEN'}. [Actual output](${log}).`,'','```text',...lines,'```','')
    }
    for(const [file,source] of originals)if(await readFile(join(root,file),'utf8')!==source)throw Error('Shared source changed during discrimination: '+file)
    report.push(`${cases.length-failures}/${cases.length} expected failures observed. Shared source bytes unchanged.`)
    await writeFile(join(evidence,'mutations.md'),report.join('\n')+'\n')
    console.log(failures?'=== DISCRIMINATION FAILED ===':'=== ALL CHECKS PASSED ===');process.exitCode=failures?1:0
  } finally {await rm(scratch,{recursive:true,force:true})}
}
main().catch(e=>{console.error(e instanceof Error?e.message:'P3 discrimination failed');process.exitCode=1})
