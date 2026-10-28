/** Exact P5 destinations; never source the application's default connection. */
import { readFileSync,statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { parse } from 'dotenv'
const proof=JSON.parse(readFileSync('docs/evidence/p5/isolation.json','utf8'))
if(!proof.createdNew||proof.productionTouched||proof.environmentPath!=='/tmp/figtree-p5-test.env'||(statSync(proof.environmentPath).mode&0o777)!==0o600)throw Error('Invalid P5 isolation proof')
const env={...process.env,...parse(readFileSync(proof.environmentPath))}
for(const [key,name] of [['TEST_DATABASE_URL',proof.testDatabase],['DATABASE_URL',proof.applicationDatabase],['APP_DATABASE_URL',proof.applicationDatabase]]) {
  if(!env[key]||new URL(env[key]).pathname.slice(1)!==name||!/^figtree_p5(_app)?_20261008_[a-f0-9]{8}_test$/.test(name))throw Error('P5 destination mismatch: '+key)
}
if(env.TEST_DATABASE_CONFIRMATION!==proof.testDatabase||proof.testDatabase===proof.applicationDatabase)throw Error('P5 test identity not confirmed')
const args=process.argv.slice(2),app=args[0]==='--app';if(app)args.shift()
if(args[0]==='run'&&args[1]==='db:migrate') {
  const destination=app?proof.applicationDatabase:proof.testDatabase
  env.DATABASE_URL=app?env.APP_DATABASE_URL:env.TEST_DATABASE_URL
  if(args[2]!=='--'||args[3]!=='--database'||args[4]!==destination)throw Error('Migrate with an exact P5 destination')
}
if(!args.length)throw Error('Provide npm command arguments')
const child=spawnSync('npm',args,{env,stdio:'inherit'});if(child.error)throw child.error
process.exitCode=child.status??1
