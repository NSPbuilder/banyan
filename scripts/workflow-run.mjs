import {readFile,stat} from 'node:fs/promises'
import {parse} from 'dotenv'
import {spawnSync} from 'node:child_process'
import assert from 'node:assert/strict'
const proof=JSON.parse(await readFile('docs/evidence/workflow-placement-2026-10-09/isolation.json','utf8'))
assert(proof.createdNew&&!proof.productionTouched&&proof.initialTables===0);assert.equal((await stat(proof.environmentPath)).mode&0o777,0o600)
const cfg=parse(await readFile(proof.environmentPath));for(const [key,name] of [['DATABASE_URL',proof.applicationDatabase],['TEST_DATABASE_URL',proof.testDatabase]])assert.equal(new URL(cfg[key]).pathname.slice(1),name)
assert.equal(cfg.TEST_DATABASE_CONFIRMATION,proof.testDatabase);assert.notEqual(proof.applicationDatabase,proof.testDatabase)
const args=process.argv.slice(2),app=args[0]==='--app';if(app)args.shift()
const env={...process.env,...cfg,NODE_OPTIONS:'',FIGTREE_TEST_ISOLATION_PROOF:'docs/evidence/workflow-placement-2026-10-09/isolation.json'}
if(args[0]==='run'&&args[1]==='db:migrate'){env.DATABASE_URL=app?cfg.DATABASE_URL:cfg.TEST_DATABASE_URL;assert.deepEqual(args.slice(2,5),['--','--database',app?proof.applicationDatabase:proof.testDatabase])}
const result=spawnSync('npm',args,{env,stdio:'inherit'});process.exitCode=result.status??1
