/** Create new P6 isolation from the already-confirmed P5 server; never use .env.local. */
import { readFileSync,writeFileSync,mkdirSync,mkdtempSync,statSync,existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'dotenv'
import postgres from 'postgres'

async function main() {
  const destination='docs/evidence/p6/isolation.json'
  if(existsSync(destination))throw Error('P6 isolation already recorded; do not recreate or reset it.')
  const proof=JSON.parse(readFileSync('docs/evidence/p5/isolation.json','utf8'))
  if(!proof.createdNew||proof.productionTouched||proof.environmentPath!=='/tmp/figtree-p5-test.env')throw Error('P5 server proof unavailable')
  const previous=parse(readFileSync(proof.environmentPath))
  const source=new URL(previous.TEST_DATABASE_URL)
  if(source.pathname.slice(1)!==proof.testDatabase||previous.TEST_DATABASE_CONFIRMATION!==proof.testDatabase)throw Error('Confirmed isolation server identity mismatch')
  const suffix=randomBytes(4).toString('hex'),testDatabase=`figtree_p6_20261008_${suffix}_test`,applicationDatabase=`figtree_p6_app_20261008_${suffix}_test`
  const adminUrl=new URL(source);adminUrl.pathname='/postgres'
  const admin=postgres(adminUrl.href,{max:1})
  try {
    for(const name of [testDatabase,applicationDatabase]) {
      if(!/^figtree_p6(_app)?_20261008_[a-f0-9]{8}_test$/.test(name))throw Error('Unsafe destination')
      await admin.unsafe(`CREATE DATABASE "${name}"`)
    }
    const test=new URL(source),app=new URL(source);test.pathname='/'+testDatabase;app.pathname='/'+applicationDatabase
    const files=mkdtempSync(join(tmpdir(),'figtree-p6-files-')),testFiles=mkdtempSync(join(tmpdir(),'figtree-p6-test-files-'))
    const projects=mkdtempSync(join(tmpdir(),'figtree-p6-project-')),testProjects=mkdtempSync(join(tmpdir(),'figtree-p6-test-project-'))
    const env={DATABASE_URL:app.href,APP_DATABASE_URL:app.href,TEST_DATABASE_URL:test.href,TEST_DATABASE_CONFIRMATION:testDatabase,
      ATTACHMENTS_DIR:files,TEST_ATTACHMENTS_DIR:testFiles,PROJECT_ATTACHMENTS_DIR:projects,TEST_PROJECT_ATTACHMENTS_DIR:testProjects,AI_KEY_SECRET:randomBytes(32).toString('hex'),
      AUTH_MFA_KEY:randomBytes(32).toString('base64'),INTEGRATION_KEY_SECRET:randomBytes(32).toString('hex'),
      AUTOMATION_ENABLED:'false',AUTH_ADMIN_MFA_REQUIRED:'false',ONLINE_PAYMENTS_ENABLED:'false',INBOUND_MAIL_ENABLED:'false',
      P5_PUBLIC_ORIGIN:'https://figtree-p6.invalid',WEBAUTHN_RP_ID:'localhost',WEBAUTHN_ORIGIN:'http://localhost:3096',PASSKEYS_ENABLED:'true'}
    const environmentPath='/tmp/figtree-p6-test.env'
    if(existsSync(environmentPath))throw Error('P6 private environment already exists; no overwrite allowed')
    writeFileSync(environmentPath,Object.entries(env).map(([k,v])=>`${k}=${v}`).join('\n')+'\n',{mode:0o600})
    if((statSync(environmentPath).mode&0o777)!==0o600)throw Error('Private environment permissions incorrect')
    const empty:Record<string,number>={}
    for(const name of [testDatabase,applicationDatabase]){
      const url=new URL(source);url.pathname='/'+name;const db=postgres(url.href,{max:1})
      try{const [count]=await db`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'`;empty[name]=count.n;if(count.n!==0)throw Error('New destination is not empty')}finally{await db.end()}
    }
    mkdirSync('docs/evidence/p6',{recursive:true})
    writeFileSync(destination,JSON.stringify({createdAt:new Date().toISOString(),createdNew:true,productionTouched:false,
      testDatabase,applicationDatabase,environmentPath,attachments:files,testAttachments:testFiles,projectAttachments:projects,testProjectAttachments:testProjects,initialPublicTables:empty},null,2)+'\n')
    console.log('Created and confirmed two empty P6 databases:',testDatabase,applicationDatabase)
  }finally{await admin.end()}
}
main().catch(e=>{console.error(e instanceof Error?e.message:'Isolation creation failed');process.exitCode=1})
