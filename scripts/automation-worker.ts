// Never load .env.local implicitly: a scheduler must choose its database.
import { writeFileSync } from 'node:fs'

async function main() {
  const args=process.argv.slice(2),at=args.indexOf('--database'),expected=args[at+1]
  const raw=process.env.DATABASE_URL
  if(at<0||!expected||!raw)throw new Error('Set DATABASE_URL explicitly and pass --database <exact database name>.')
  const url=new URL(raw),actual=decodeURIComponent(url.pathname.slice(1))
  if(!['postgres:','postgresql:'].includes(url.protocol)||actual!==expected)throw new Error('Worker database confirmation does not match.')
  if(process.env.AUTOMATION_ENABLED!=='true')throw new Error('Worker is paused. Explicit AUTOMATION_ENABLED=true is required.')
  const maxAt=args.indexOf('--max'),max=maxAt<0?12:Number(args[maxAt+1])
  const {automationBatch}=await import('../src/lib/automation-worker')
  const result=await automationBatch(max)
  if(process.env.AUTOMATION_RESULT_FILE)writeFileSync(process.env.AUTOMATION_RESULT_FILE,JSON.stringify(result)+'\n',{mode:0o600})
  console.log(JSON.stringify(result))
}
main().then(()=>process.exit(0)).catch(error=>{console.error(error instanceof Error?error.message:'Worker failed.');process.exit(1)})
