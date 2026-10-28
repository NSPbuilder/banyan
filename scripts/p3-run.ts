/** P3 verification launcher: both destinations must match the recorded new isolation. */
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { parse } from 'dotenv'
const proof=JSON.parse(readFileSync('docs/evidence/p3/isolation.json','utf8'))
const env={...process.env,...parse(readFileSync(proof.environmentPath))}
if(!proof.createdNew||proof.productionTouched||!proof.environmentPath||proof.testDatabase===proof.applicationDatabase)throw Error('Invalid P3 isolation proof')
for(const [key,name] of [['TEST_DATABASE_URL',proof.testDatabase],['DATABASE_URL',proof.applicationDatabase],['APP_DATABASE_URL',proof.applicationDatabase]]) {
 if(!env[key]||new URL(env[key]).pathname.slice(1)!==name||!/^[a-z][a-z0-9_]*_test$/.test(name))throw Error('P3 destination identity mismatch: '+key)
}
if(env.TEST_DATABASE_CONFIRMATION!==proof.testDatabase)throw Error('Missing exact test identity confirmation')
const args=process.argv.slice(2),app=args[0]==='--app';if(app)args.shift()
if(args[0]==='run'&&args[1]==='db:migrate') {
 const destination=app?proof.applicationDatabase:proof.testDatabase
 env.DATABASE_URL=app?env.APP_DATABASE_URL:env.TEST_DATABASE_URL
 if(args[2]!=='--'||args[3]!=='--database'||args[4]!==destination)throw Error('Migrate with explicit P3 destination')
}
if(!args.length)throw Error('Provide npm command arguments')
const child=spawnSync('npm',args,{env,stdio:'inherit'})
if(child.error)throw child.error
process.exitCode=child.status??1
