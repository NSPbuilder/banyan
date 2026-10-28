import {readFile,writeFile,open,mkdir,realpath} from 'node:fs/promises'
import {spawn,execFileSync} from 'node:child_process'
import {parse} from 'dotenv'
import assert from 'node:assert/strict'
import {join} from 'node:path'
const mode=process.argv[2];assert(['qa','review'].includes(mode));const out='docs/evidence/workflow-placement-2026-10-09'
const proof=JSON.parse(await readFile(out+'/isolation.json','utf8')),cfg=parse(await readFile(proof.environmentPath)),{scratch}=JSON.parse(await readFile(out+'/build-state.json','utf8'))
assert(proof.createdNew&&!proof.productionTouched);assert.equal(new URL(cfg.DATABASE_URL).pathname.slice(1),proof.applicationDatabase)
assert(await readFile(join(scratch,'.next/BUILD_ID'),'utf8'))
const path=mode==='qa'?'/tmp/figtree-workflow-browser-server.json':'/tmp/figtree-ui-local-review/state.json',log=mode==='qa'?'/tmp/figtree-workflow-browser-server.log':'/tmp/figtree-ui-local-review/server.log'
let previous;try{previous=JSON.parse(await readFile(path,'utf8'))}catch(e){if(e.code!=='ENOENT')throw e}
if(previous?.pid){let alive=true;try{process.kill(previous.pid,0)}catch(e){if(e.code==='ESRCH')alive=false;else throw e}
 if(alive){const cwd=execFileSync('lsof',['-a','-p',String(previous.pid),'-d','cwd','-Fn'],{encoding:'utf8'}).split('\n').find(v=>v.startsWith('n'))?.slice(1);assert.equal(cwd,await realpath(previous.scratch??previous.buildDir??previous.cwd??previous.build),'Only replace verified review process');process.kill(previous.pid,'SIGTERM');for(let i=0;i<50;i++){try{process.kill(previous.pid,0)}catch(e){if(e.code==='ESRCH')break;throw e}await new Promise(r=>setTimeout(r,100))}}
}
await mkdir('/tmp/figtree-ui-local-review',{recursive:true});const handle=await open(log,'a',0o600),port=mode==='qa'?3100:3000
const child=spawn(process.execPath,[join(scratch,'node_modules/next/dist/bin/next'),'start','--hostname','127.0.0.1','--port',String(port)],{cwd:scratch,env:{...process.env,...cfg,NODE_OPTIONS:'',NODE_ENV:'production',AUTOMATION_ENABLED:mode==='qa'?'true':'false',ONLINE_PAYMENTS_ENABLED:'false',INBOUND_MAIL_ENABLED:'false'},detached:true,stdio:['ignore',handle.fd,handle.fd]});child.unref();await handle.close()
await writeFile(path,JSON.stringify({pid:child.pid,scratch,port,database:proof.applicationDatabase,externalDeliveryEnabled:false},null,2)+'\n',{mode:0o600})
for(let i=0;i<60;i++){try{const r=await fetch('http://127.0.0.1:'+port+'/login');if(r.ok){console.log('Verified local '+mode+' server ready at http://127.0.0.1:'+port);process.exit(0)}}catch{}await new Promise(r=>setTimeout(r,250))}
throw Error('Local server readiness failed')
