import './dotenv'
import { reconcileSigningRequests } from '../src/lib/esign'
import { sql as connection } from '../src/db/client'

reconcileSigningRequests().then(result => {
  console.log(`Signing sync: ${result.updated} updated, ${result.failed} need retry.`)
  if (result.failed) process.exitCode = 1
}).catch(() => { console.error('Signing sync could not complete. Check connection settings and database migrations.'); process.exitCode = 1 })
  .finally(() => connection.end())
