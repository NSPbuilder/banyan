/**
 * Restore the newest backup into a scratch database and compare it, entry by
 * entry, with the books it came from.
 *
 *   npm run backup:check
 *
 * A backup nobody has restored is a file, not a backup. Checking that the file
 * exists, or that it is a plausible size, is the shape of check this project
 * has been caught by ten times: it reports a success it did not earn. The only
 * question worth asking is whether the ledger comes back.
 */
import './dotenv'
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backupDir, pgTool } from '../src/lib/backup-paths'
import { TABLES_SQL, fingerprintDifferences, fingerprintSql, parseFingerprint } from '../src/lib/backup-fingerprint'

const SCRATCH = 'figtree_restore_' + randomBytes(12).toString('hex')
const createdDatabases = new Set<string>()
const temporaryDirectories = new Set<string>()

let failures = 0
// Failures that bear on the BACKUP, as against failures of this script's own
// housekeeping. Both are failures and both exit non-zero — a scratch database
// left behind should not pass silently — but only the first kind licenses the
// sentence "the backup cannot be trusted", and the banner used to say it for
// either. This file exists so that nobody is told something about a backup that
// is not true; saying that of a failed DROP DATABASE is that same fault.
let backupFailures = 0
/** The labels of what failed, by kind — the banner names them rather than the dump. */
const backupProblems: string[] = []
const housekeepingProblems: string[] = []
const pass = (l: string, d = '') => console.log(`PASS  ${l.padEnd(46)}  ${d}`)
const fail = (l: string, d = '') => {
  failures++; backupFailures++; backupProblems.push(l); console.log(`FAIL  ${l.padEnd(46)}  ${d}`)
}
/** A failure of the check's own housekeeping. Counts, but says nothing about the backup. */
const failHousekeeping = (l: string, d = '') => {
  failures++; housekeepingProblems.push(l); console.log(`FAIL  ${l.padEnd(46)}  ${d}`)
}

/**
 * The check records itself, so the company page can say how long it has been.
 * It cannot be scheduled — it needs the repository, which the scheduler may
 * not read — so the only way it gets done is that its absence shows.
 */
let newestName = ''
let manifestName = ''
let checkSessionCreated = false
/** The books' URL, once main() knows it, so finish() can tidy the check's own rows. */
let booksUrl = ''
let adminUrlForCleanup = ''
function dropOwnedDatabase(name: string) {
  if (!createdDatabases.has(name)) return
  if (!adminUrlForCleanup) throw Error('Owned restore database has no cleanup connection')
  execFileSync(pgTool('psql'), ['-q', '-d', adminUrlForCleanup, '-c',
    `DROP DATABASE "${name}" WITH (FORCE)`])
  createdDatabases.delete(name)
}
function finish(): never {
  // The session this check minted to be let in is a row in the books. Left
  // there, the NEXT run compares a dump without it against books with it and
  // condemns the backup for a row of the check's own making (user_session:
  // books 28 vs restored 27, the second time the whole-table fingerprint ran).
  // So the check leaves the books as it found them.
  if (booksUrl && checkSessionCreated) {
    try {
      execFileSync(pgTool('psql'), ['-tAq', '-d', booksUrl, '-c',
        `DELETE FROM user_session WHERE user_agent = 'restore-check'`], { encoding: 'utf8' })
    } catch (e) {
      failHousekeeping('R8 the check removed its own session rows', e instanceof Error ? e.message.slice(0, 160) : String(e))
    }
  }
  for (const name of createdDatabases) {
    try {
      dropOwnedDatabase(name)
    } catch (e) {
      failHousekeeping('R8b the scratch restore database was removed',
        e instanceof Error ? e.message.slice(0, 160) : String(e))
    }
  }
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true })
  try {
    writeFileSync(join(backupDir(), 'last-check.json'), JSON.stringify({
      at: new Date().toISOString(), ok: failures === 0, backupOk: backupFailures === 0, newest: newestName,
      manifest: manifestName || undefined, scope: 'complete-set', sameMachine: true,
      newMachineVerified: false, problems: backupProblems, housekeeping: housekeepingProblems,
    }))
  } catch (e) {
    console.error(`could not record this check in ${backupDir()}: ${e instanceof Error ? e.message : e}`)
  }
  process.exit(failures === 0 ? 0 : 1)
}

/**
 * A session for this check, minted straight into the table.
 *
 * The backup route is a POST behind an owner now, so the check has to be
 * somebody. It creates a throwaway owner if none exists and hands back the raw
 * token; the table stores only its SHA-256, exactly as `users.ts` does — this
 * is the one place outside that file allowed to know the shape, and it says so.
 */
async function sessionForCheck(appUrl: string): Promise<string> {
  const { hashPassword } = await import('../src/lib/users')

  // The APP's database, explicitly. This used to reach for `src/db/client`,
  // which reads `DATABASE_URL` — and `scripts/env.ts` has already replaced that
  // with `TEST_DATABASE_URL` by the time this file's first import returns. So
  // the session row went into `erp_test` while the application read `erp_dev`,
  // and `R7a` answered 401 for every run since 0053 made the route need one.
  // It was invisible because `backup:check` is not in the battery: nothing else
  // runs this file.
  const run = (text: string) =>
    execFileSync(pgTool('psql'), ['-tAq', '-d', appUrl, '-c', text], { encoding: 'utf8' }).trim()

  const lit = (v: string) => `'${v.replace(/'/g, "''")}'`
  let userId = run(`SELECT id::text FROM app_user WHERE is_owner AND is_active LIMIT 1`)
  if (!userId) {
    userId = run(`
      INSERT INTO app_user (email, first_name, last_name, password_hash, kind, created_by)
      VALUES ('restore-check@example.test', 'Restore', 'check',
              ${lit(await hashPassword(randomBytes(24).toString('base64url')))},
              'superadmin', 'restore-check')
      RETURNING id::text`)
  }
  const token = randomBytes(32).toString('base64url')
  run(`
    INSERT INTO user_session (user_id, token_hash, expires_at, user_agent)
    VALUES (${lit(userId)}::uuid, ${lit(createHash('sha256').update(token).digest('hex'))},
            now() + interval '1 hour', 'restore-check')`)
  checkSessionCreated = true
  return token
}

function sha256(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const digest = createHash('sha256')
    createReadStream(path).on('data', (chunk) => digest.update(chunk))
      .on('error', reject).on('end', () => resolve(digest.digest('hex')))
  })
}

async function main() {
  // psql everywhere: one way of reading, and it needs no driver at all.
  const url = process.env.RESTORE_CHECK_DATABASE_URL ?? process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set')
  booksUrl = url

  // Where the scheduler writes them: macOS refuses a LaunchAgent access to
  // ~/Documents, so the dumps cannot live in the repository.
  const dir = join(backupDir(), 'backups')

  type Manifest = {
    format: string; complete: boolean; problems: string[]
    files: Array<{ name: string; role: string; bytes: number; sha256: string }>
    attachments: { missing_or_changed: string[] }
  }
  const manifests = readdirSync(dir).filter((f) => f.endsWith('.manifest.json'))
    .map((f) => ({ f, at: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.at - a.at)
  let manifest: Manifest | null = null
  if (manifests[0]) {
    manifestName = manifests[0].f
    try {
      manifest = JSON.parse(readFileSync(join(dir, manifestName), 'utf8')) as Manifest
    } catch (error) {
      fail('R1b the newest manifest is readable', error instanceof Error ? error.message : String(error))
    }
  } else {
    fail('R1b a complete-set manifest exists', 'legacy database dumps remain readable but are not complete backup sets')
  }

  const all = readdirSync(dir)
    .filter((f) => f.endsWith('.dump'))
    .map((f) => ({ f, at: statSync(join(dir, f)).mtimeMs, size: statSync(join(dir, f)).size }))
    .sort((a, b) => b.at - a.at)

  // An empty file is not a backup, and it would otherwise be checked simply
  // because it is the newest thing in the directory. Housekeeping, not a
  // verdict on the backup: the dump this run goes on to restore is a
  // different file, and the banner must not condemn it for a stray.
  const empty = all.filter((d) => d.size === 0)
  if (empty.length > 0) {
    failHousekeeping('R0 no empty dumps are lying around',
         `${empty.map((e) => e.f).join(', ')} — delete them, they are not backups`)
  }
  const dumps = all.filter((d) => d.size > 0)

  if (dumps.length === 0) {
    fail('R1 found the newest backup', `${dir} holds no .dump file`)
    finish()
  }
  const dumpRecord = manifest?.files.find((f) => f.role === 'postgres-custom-archive')
  const selected = dumpRecord ? dumps.find((d) => d.f === dumpRecord.name) : dumps[0]
  if (!selected) {
    fail('R1 found the database file named by the manifest', dumpRecord?.name ?? 'no database file')
    finish()
  }
  const newest = join(dir, selected.f)
  newestName = selected.f
  const ageHours = (Date.now() - selected.at) / 3_600_000
  pass('R1 found the newest backup', `${dumps[0].f}, ${ageHours.toFixed(1)}h old`)

  if (manifest) {
    ['figtree-full-backup-v1','figtree-full-backup-v2'].includes(manifest.format)
      ? pass('R1b the complete-set manifest is recognised', manifestName)
      : fail('R1b the complete-set manifest is recognised', manifest.format)
    manifest.complete
      ? pass('R1c the set was complete when written')
      : fail('R1c the set was complete when written', manifest.problems.join('; '))
    for (const file of manifest.files) {
      const path = join(dir, file.name)
      if (!existsSync(path)) {
        fail('R1d every manifested file is present', file.name)
        continue
      }
      const actual = await sha256(path)
      actual === file.sha256 && statSync(path).size === file.bytes
        ? pass(`R1d checksum ${file.role}`, file.name)
        : fail(`R1d checksum ${file.role}`, `${file.name} changed or is truncated`)
    }
  }

  const admin = new URL(url); admin.pathname = '/postgres'
  adminUrlForCleanup = admin.toString()
  const scratchUrl = new URL(url); scratchUrl.pathname = `/${SCRATCH}`

  const psql = (target: string, sqlText: string) =>
    execFileSync(pgTool('psql'), ['-tAq', '-d', target, '-c', sqlText], { encoding: 'utf8' }).trim()

  execFileSync(pgTool('psql'), ['-q', '-d', admin.toString(), '-c', `CREATE DATABASE "${SCRATCH}"`])
  createdDatabases.add(SCRATCH)

  try {
    // pg_restore reports non-fatal notices on stderr; only a non-zero exit is a
    // failure, and --exit-on-error makes sure one is not swallowed.
    execFileSync(pgTool('pg_restore'), ['--exit-on-error', '-d', scratchUrl.toString(), newest],
                 { stdio: ['ignore', 'ignore', 'pipe'] })
    pass('R2 the backup restores without error', SCRATCH)
  } catch (e) {
    const stderr = (e as { stderr?: Buffer }).stderr?.toString().slice(0, 200) ?? String(e)
    fail('R2 the backup restores without error', stderr)
    finish()
  }

  // The database relationship and original bytes must survive together.
  // Extract to a disposable directory and re-hash every blob referenced by
  // the restored database; checking only the tar's table of contents is not a
  // restore test.
  const paperRecord = manifest?.files.find((f) => f.role === 'attachment-store')
  const extracted = mkdtempSync(join(tmpdir(), 'figtree-restore-paper-'))
  if (!paperRecord) {
    fail('R2b attachment originals are part of the set', 'no attachment archive in manifest')
  } else {
    try {
      execFileSync('tar', ['-xzf', join(dir, paperRecord.name), '-C', extracted])
      const expected = psql(scratchUrl.toString(), `
        SELECT DISTINCT sha256 FROM attachment
        UNION SELECT DISTINCT sha256 FROM minute_book_attachment
        UNION SELECT DISTINCT sha256 FROM crm_attachment
        ORDER BY 1`).split('\n').filter(Boolean)
      const files: string[] = []
      const walk = (at: string) => {
        for (const item of readdirSync(at, { withFileTypes: true })) {
          const full = join(at, item.name)
          if (item.isDirectory()) walk(full)
          else if (item.isFile() && full.includes(`${join('', 'blobs')}/`)) files.push(full)
        }
      }
      walk(extracted)
      const byName = new Map(files.map((f) => [f.split('/').at(-1)!, f]))
      const bad: string[] = []
      for (const expectedHash of expected) {
        const held = byName.get(expectedHash)
        if (!held || await sha256(held) !== expectedHash) bad.push(expectedHash)
      }
      bad.length === 0
        ? pass('R2b attachment relationships and original bytes came back', `${expected.length} referenced blobs`)
        : fail('R2b attachment relationships and original bytes came back', `${bad.length} missing or changed`)
    } catch (error) {
      fail('R2b attachment relationships and original bytes came back', error instanceof Error ? error.message : String(error))
    }
  }
  rmSync(extracted, { recursive: true, force: true })
  // A separate domain: UUID-scoped Project blobs must be in the Project
  // archive under the correct company/project, never satisfied by GL paper.
  const hasProjects=psql(scratchUrl.toString(),`SELECT to_regclass('public.project_attachment_blob') IS NOT NULL`)==='t'
  const expectedProject = hasProjects?psql(scratchUrl.toString(), `SELECT entity_id||'/'||project_id||'/blobs/'||sha256 FROM project_attachment_blob ORDER BY 1`).split('\n').filter(Boolean):[]
  const projectRecord=manifest?.files.find(f=>f.role==='project-attachment-store')
  const projectExtracted=mkdtempSync(join(tmpdir(),'figtree-restore-project-'))
  try {
    if(projectRecord)execFileSync('tar',['-xzf',join(dir,projectRecord.name),'-C',projectExtracted])
    const found=new Map<string,string>()
    const walkProject=(at:string)=>{for(const item of readdirSync(at,{withFileTypes:true})){const full=join(at,item.name);if(item.isDirectory())walkProject(full);else if(item.isFile()){const pieces=full.split('/');if(pieces.at(-2)==='blobs')found.set(pieces.slice(-4).join('/'),full)}}}
    walkProject(projectExtracted)
    const bad=[]
    for(const key of expectedProject){const file=found.get(key);if(!file||await sha256(file)!==key.split('/').at(-1))bad.push(key)}
    if(bad.length)fail('R2c Project originals came back in their own domain',`${bad.length} missing or changed`)
    else pass('R2c Project originals came back in their own domain',`${expectedProject.length} scoped blobs`)
  } catch(error){fail('R2c Project originals came back in their own domain',error instanceof Error?error.message:String(error))}
  finally {rmSync(projectExtracted,{recursive:true,force:true})}

  // R3 — EVERY table, not the eleven figures over eight tables this used to be.
  //      Payroll, SR&ED, the attachments and the registers could come back
  //      empty and the old fingerprint said the backup was good. The list is
  //      the live catalogue's, so a table added later is compared later, and
  //      the restored copy is asked about the live tables — one it lacks is a
  //      difference, not an omission.
  const tablesOf = (target: string) => psql(target, TABLES_SQL).split('\n').filter(Boolean)
  const liveTables = tablesOf(url)
  const restoredTables = new Set(tablesOf(scratchUrl.toString()))
  const missing = liveTables.filter((t) => !restoredTables.has(t))
  missing.length === 0
    ? pass('R3a every table came back', `${liveTables.length} tables`)
    : fail('R3a every table came back', `missing from the restore: ${missing.join(', ')}`)

  const fingerprint = (target: string) => parseFingerprint(psql(target, fingerprintSql(liveTables)))
  const live = fingerprint(url)
  const restored = missing.length === 0 ? fingerprint(scratchUrl.toString()) : new Map<string, string>()

  const differences = fingerprintDifferences(live, restored)
  differences.length === 0
    ? pass('R3 the restored database matches the books, table by table',
           `${live.size} figures identical, e.g. ` + ['journal_entry', 'pay_stub', 'sred_claim', 'attachment_blob', 'share_transaction']
             .filter((n) => live.has(n)).map((n) => `${n}=${live.get(n)}`).join(' '))
    : fail('R3 the restored database matches the books, table by table', differences.join('; '))

  const auditDigest = (target: string) => psql(target, `
    SELECT md5(COALESCE(string_agg(row_to_json(a)::text, '|' ORDER BY a.id), ''))
      FROM audit_log a`)
  const liveAudit = auditDigest(url), restoredAudit = auditDigest(scratchUrl.toString())
  liveAudit === restoredAudit
    ? pass('R3b audit people, times, values and sources are unchanged', liveAudit)
    : fail('R3b audit people, times, values and sources are unchanged', 'audit content differs')

  // R4 — the figures themselves, account by account, not just the counts. Two
  //      ledgers can hold the same number of lines and different money.
  const perAccount = (target: string) => psql(target, `
    SELECT a.code || ':' || COALESCE(SUM(jl.amount), 0)
      FROM account a LEFT JOIN journal_line jl ON jl.account_id = a.id
      GROUP BY a.code ORDER BY a.code`)
  const liveBalances = perAccount(url)
  const restoredBalances = perAccount(scratchUrl.toString())
  liveBalances === restoredBalances
    ? pass('R4 every account balance came back', liveBalances.split('\n').length + ' accounts, identical')
    : fail('R4 every account balance came back',
           `books:\n${liveBalances}\nrestored:\n${restoredBalances}`)

  // R5 — and the guards came with it. A restore that loses the triggers gives
  //      you a database that looks right and enforces nothing.
  const triggers = (target: string) =>
    psql(target, `SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal`)
  const functions = (target: string) =>
    psql(target, `SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                   WHERE n.nspname = 'public'`)
  const liveT = triggers(url), restoredT = triggers(scratchUrl.toString())
  const liveF = functions(url), restoredF = functions(scratchUrl.toString())
  liveT === restoredT && liveF === restoredF && Number(liveT) > 0
    ? pass('R5 the guards came back too', `${liveT} triggers, ${liveF} functions`)
    : fail('R5 the guards came back too',
           `triggers ${liveT} vs ${restoredT}, functions ${liveF} vs ${restoredF}`)

  // R6 — and they still refuse what they should. A trigger that exists but does
  //      not fire is the same as no trigger.
  try {
    psql(scratchUrl.toString(),
      `UPDATE journal_entry SET entry_date = entry_date + 1
        WHERE status = 'posted' AND entry_no IS NOT NULL`)
    const anyPosted = psql(scratchUrl.toString(),
      `SELECT count(*) FROM journal_entry WHERE status = 'posted'`)
    Number(anyPosted) === 0
      ? pass('R6 guards enforce in the restored copy', 'no posted entries to test against')
      : fail('R6 guards enforce in the restored copy', 'a posted entry was edited')
  } catch {
    pass('R6 guards enforce in the restored copy', 'editing a posted entry was refused')
  }

  // R7 — a backup taken through the browser must be the same thing. It exists
  //      so the person can put a copy on an external disk, and a copy that
  //      cannot be restored is worse than no copy: they would believe they have
  //      one. Only checked when the app happens to be running.
  // Set once the dump BYTES ARE ON DISK, not when the response headers arrived.
  // Everything after that — psql, pg_restore, fingerprint — can still throw,
  // and those throws land in the same catch as a failed fetch. Without the flag
  // the catch reported `R7a the app serves a backup to download` as failing
  // when the app had already served one.
  //
  // The first version set it right after `response.ok`, which is before
  // `arrayBuffer()` and before the file is written — and the 30s timeout covers
  // the body stream, so a slow body would have been reported as the restore
  // comparison failing when no restore had been attempted.
  if (process.env.CHECK_BROWSER_DOWNLOAD !== 'yes') {
    console.log(`SKIP  ${'R7 database-only browser copy'.padEnd(46)}  set CHECK_BROWSER_DOWNLOAD=yes to exercise it`)
  } else {
  let served = false
  let targetReady = false
  let reported = false
  let downloadStarted = false
  try {
    // The route is now a POST behind an owner (0053, RISKS §15b), so this
    // check has to BE somebody. It mints a session row directly — it has the
    // database anyway — rather than driving the sign-in form, because what it
    // is checking is the backup, not the login.
    const session = await sessionForCheck(url)
    const origin = new URL(process.env.RESTORE_CHECK_ORIGIN || 'http://localhost:3000')
    if (!['http:', 'https:'].includes(origin.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
      || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw Error('Restore check requires a loopback application origin')
    const response = await fetch(new URL('/backup/download', origin), {
      method: 'POST',
      headers: { cookie: `erp_session=${session}` },
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) {
      fail('R7a the app serves a backup to download',
        response.status === 401 || response.status === 403
          ? `the app answered ${response.status} — the check's session was not accepted`
          : `the app answered ${response.status}`)
    } else {
      downloadStarted = true
      const downloadDirectory = mkdtempSync(join(tmpdir(), 'figtree-download-check-'))
      temporaryDirectories.add(downloadDirectory)
      const downloaded = join(downloadDirectory, 'backup.dump')
      writeFileSync(downloaded, Buffer.from(await response.arrayBuffer()))
      served = true

      const target = `${SCRATCH}_download`
      execFileSync(pgTool('psql'), ['-q', '-d', admin.toString(), '-c', `CREATE DATABASE "${target}"`])
      createdDatabases.add(target)
      targetReady = true

      const downloadUrl = new URL(url); downloadUrl.pathname = `/${target}`
      execFileSync(pgTool('pg_restore'), ['--exit-on-error', '-d', downloadUrl.toString(), downloaded],
                   { stdio: ['ignore', 'ignore', 'pipe'] })

      // Against the books AS THEY ARE NOW, not the fingerprint taken before
      // R7 began: this check minted a session row into the books to be let
      // in, so the books moved by one row of its own making between the two
      // — and the whole-table fingerprint, unlike the old eleven figures,
      // counts user_session and saw it (books 27 vs restored 28, the first
      // time it ran). Nothing else writes to the books during the check.
      const liveNow = fingerprint(url)
      const downloadedDiff = fingerprintDifferences(liveNow, fingerprint(downloadUrl.toString()))
      downloadedDiff.length === 0
        ? pass('R7 a downloaded backup restores to the same ledger', `same ${liveNow.size} figures as the books`)
        : fail('R7 a downloaded backup restores to the same ledger', downloadedDiff.join('; '))
      // R7 has now had its say, once. The tidying below is still inside this
      // `try`, and a throw in it used to reach the catch with `served` true and
      // print a SECOND `FAIL R7` — for an assertion that had already passed.
      reported = true

      dropOwnedDatabase(target)
      rmSync(downloadDirectory, { recursive: true, force: true })
      temporaryDirectories.delete(downloadDirectory)
    }
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e)
    if (reported) {
      // R7 already said its piece; this is the cleanup after it throwing.
      // Its own id, because the tidying falling over is not the restore
      // failing. It DOES still count toward this run's verdict — a scratch
      // database left behind should not pass silently — so the banner at the
      // end is about the run, not about the backup, and the comment no longer
      // claims otherwise.
      failHousekeeping('R7b the download check tidied up after itself', why.slice(0, 160))
    } else if (served && !targetReady) {
      // Between the bytes landing and the scratch database existing. A
      // DROP/CREATE that fails against the live server says nothing about the
      // downloaded backup — this was `R7`'s, which made `R7` the catch-all the
      // split was supposed to remove. Moving a condition off one id and onto
      // another is not splitting it.
      failHousekeeping('R7d the scratch database for the download check could be made',
        why.slice(0, 160))
    } else if (served) {
      // Past the scratch database and before R7 reported, so this IS the
      // restore comparison failing, under the label that names it.
      fail('R7 a downloaded backup restores to the same ledger', why.slice(0, 160))
    } else if (downloadStarted) {
      // The app answered 200 and then the bytes did not land — a stalled body
      // stream, a full disk, an unwritable tmpdir. One id over both a possibly
      // server-side cause (the stall) and two local ones, so it goes through
      // the HOUSEKEEPING channel: the banner must never condemn a backup for a
      // full disk on the checking machine, and a genuinely stalled stream
      // printing the housekeeping banner understates, which is the tolerable
      // direction. Not "the app is not running" (the old wording, which the
      // 30s timeout covering the body stream made reachable and wrong).
      failHousekeeping('R7c the served backup arrived in full', why.slice(0, 160))
    } else if (/fetch failed|ECONNREFUSED|timeout/i.test(why)) {
      console.log(`SKIP  ${'R7a the app serves a backup to download'.padEnd(46)}  the app is not running`)
    } else {
      fail('R7a the app serves a backup to download', why.slice(0, 160))
    }
  }
  }

  dropOwnedDatabase(SCRATCH)

  console.log(failures === 0
    ? `\n=== THE BACKUP RESTORES TO THE SAME LEDGER ===`
    : backupFailures > 0
      ? `\n=== ${failures} CHECK(S) FAILED — THE BACKUP CANNOT BE TRUSTED ===`
      : `\n=== ${failures} CHECK(S) FAILED IN THIS CHECK'S OWN HOUSEKEEPING ===`)
  finish()
}

// A crash anywhere is still an exit: record it (as the check's own failure —
// a throw says nothing about the backup) and tidy up, or the previous
// last-check.json stands and the minted session row stays in the books.
main().catch((e) => {
  console.error(e)
  failHousekeeping('R9 the check ran to its end', e instanceof Error ? e.message.slice(0, 160) : String(e))
  finish()
})
