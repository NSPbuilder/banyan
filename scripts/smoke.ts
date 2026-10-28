import './env'
import {execFileSync} from 'node:child_process'
import {pgTool} from '../src/lib/backup-paths'
execFileSync('npm',['run','db:reset'],{stdio:'inherit',env:{...process.env}})
for(const file of ['db/test/smoke.sql','db/test/discriminate.sql'])
  execFileSync(pgTool('psql'),['-d',process.env.TEST_DATABASE_URL!,'-v','ON_ERROR_STOP=1','-f',file],{stdio:'inherit'})
