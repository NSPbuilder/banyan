import {mkdtemp,cp,symlink,readFile,writeFile,constants} from 'node:fs/promises'
import {spawnSync} from 'node:child_process'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {parse} from 'dotenv'
import assert from 'node:assert/strict'
const root=process.cwd(),out=join(root,'docs/evidence/workflow-placement-2026-10-09'),proof=JSON.parse(await readFile(join(out,'isolation.json'),'utf8')),cfg=parse(await readFile(proof.environmentPath))
assert(proof.createdNew&&!proof.productionTouched);assert.equal(new URL(cfg.DATABASE_URL).pathname.slice(1),proof.applicationDatabase)
const scratch=await mkdtemp(join(tmpdir(),'figtree-workflow-build-'))
for(const path of ['src','public','scripts','db/migrations','package.json','package-lock.json','tsconfig.json','next.config.ts','postcss.config.mjs','next-env.d.ts','eslint.config.mjs'])await cp(join(root,path),join(scratch,path),{recursive:true,mode:constants.COPYFILE_FICLONE})
await symlink(join(root,'node_modules'),join(scratch,'node_modules'),'dir');await writeFile(join(out,'build-state.json'),JSON.stringify({scratch},null,2)+'\n')
const result=spawnSync(process.execPath,[join(scratch,'node_modules/next/dist/bin/next'),'build','--webpack'],{cwd:scratch,env:{...process.env,...cfg,NODE_OPTIONS:'',NODE_ENV:'production'},encoding:'utf8',maxBuffer:30e6})
await writeFile(join(out,'build.log'),result.stdout+result.stderr);console.log('Production build',result.status,scratch);process.exitCode=result.status??1
