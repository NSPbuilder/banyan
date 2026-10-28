import {execFileSync} from 'node:child_process'
import {readFileSync} from 'node:fs'
import {verifyDependencyPatches} from './dependency-patches'
console.log(`Dependency patch: ${verifyDependencyPatches()} integrity and behavior checks passed.`)
type Exception={advisory:string;package:string;version:string;owner:string;reason:string;expires:string}
type Advisory={severity:string;url:string;name:string;title:string}
type Audit={vulnerabilities?:Record<string,{name:string;severity:string;nodes:string[];via:Array<string|Advisory>}>;error?:unknown}
const exceptions=JSON.parse(readFileSync('docs/implementation/security-exceptions.json','utf8')) as Exception[]
let text:string
try{text=execFileSync('npm',['audit','--json'],{encoding:'utf8',stdio:['ignore','pipe','pipe']})}
catch(e){text=String((e as {stdout?:string}).stdout ?? '')}
const result=JSON.parse(text) as Audit
if(result.error || !result.vulnerabilities)throw new Error('Dependency audit unavailable; cannot certify dependencies.')
let failed=0,waived=0
for(const issue of Object.values(result.vulnerabilities))for(const via of issue.via){
  if(typeof via==='string' || !['high','critical'].includes(via.severity))continue
  const id=via.url.split('/').at(-1)
  // Audit nodes identify every affected installation, including nested copies.
  // A top-level patched version must not waive a vulnerable nested version.
  const installedVersions=[...new Set(issue.nodes.map(node=>JSON.parse(readFileSync(`${node}/package.json`,'utf8')))
    .filter(p=>p.name===via.name).map(p=>p.version as string))]
  if(!installedVersions.length)throw Error(`Cannot resolve affected installations: ${via.name}`)
  for(const installed of installedVersions){
  const allowed=exceptions.find(x=>x.advisory===id && x.package===via.name && x.version===installed
    && x.owner && x.reason && /^\d{4}-\d{2}-\d{2}$/.test(x.expires) && new Date(x.expires+'T00:00:00Z').getTime()>Date.now())
  if(allowed){waived++;console.log(`Temporary exception ${id}: ${via.name}@${installed}, owner ${allowed.owner}, expires ${allowed.expires}`)}
  else{failed++;console.error(`BLOCK ${via.severity}: ${via.name}@${installed} ${id}`)}
  }
}
console.log(`Dependency policy: ${failed} blocked advisories, ${waived} temporary exceptions. Moderate/low remain visible in npm audit.`)
process.exitCode=failed?1:0
