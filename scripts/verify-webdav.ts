/** Read-only WebDAV, company-scoped credentials and virtual folders.
 * Run after resetting the TEST database: npm run db:verify-webdav. */
import './env'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, promises as fs } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

process.env.ATTACHMENTS_DIR = process.env.WEB_DAV_TEST_STORE
  ?? mkdtempSync(path.join(os.tmpdir(), 'figtree-dav-'))

import { sql } from 'drizzle-orm'
import { db, sql as conn } from '../src/db/client'
import { createCompanyWithYear } from '../src/lib/setup'
import { deleteCompany } from '../src/lib/companies'
import { importAccounts, parseAccountsCsv } from '../src/lib/accounts'
import { postEntry } from '../src/lib/posting'
import { parseMoney } from '../src/lib/money'
import { addMinuteBookEntry } from '../src/lib/records'
import { saveAttachment, webdavFilesOf } from '../src/lib/attachments'
import { attachToMinuteBook } from '../src/modules/records/attachments'
import { createFirstOwner, createUser, setPassword, setUserStatus } from '../src/lib/users'
import { setGrantsFromForm } from '../src/lib/user-forms'
import { USER_FIELDS as F } from '../src/lib/forms'
import {
  authenticateWebDav, revokeWebDavCredential, rotateWebDavCredential,
  webdavCredentialStatus, webdavRights,
} from '../src/lib/webdav-credentials'
import { handleWebDav } from '../src/lib/webdav'
import { tinyPdf } from './suite'

const origin = 'https://figtree.example.test'
const basic = (email: string, password: string) =>
  `Basic ${Buffer.from(`${email}:${password}`).toString('base64')}`
const request = (url: string, method: string, auth?: string, extra?: Record<string, string>) =>
  new Request(url, { method, headers: { ...(auth ? { Authorization: auth } : {}), ...extra } })
const href = (entityId: string, segments: string[]) =>
  `${origin}/dav/${entityId}/${segments.map(encodeURIComponent).join('/')}`

async function liveRequest(base: string, entityId: string, segments: string[], method: string, auth: string) {
  const url = new URL(href(entityId, segments).replace(origin, base))
  return new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
    const call = http.request(url, { method, headers: { Authorization: auth, Depth: '1' } }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (part: Buffer) => chunks.push(part))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) }))
    })
    call.on('error', reject)
    call.end()
  })
}

async function main() {
  const owner = await createFirstOwner({
    email: 'owner@dav.test', firstName: 'Owner', password: 'a very long owner password',
  })
  const user = await createUser({
    email: 'reader@dav.test', firstName: 'Reader', password: 'a very long reader password',
    actor: owner.email,
  })
  const a = await createCompanyWithYear({ code: 'DAVA', name: 'WebDAV Alpha Ltd.' }, owner.email)
  const b = await createCompanyWithYear({ code: 'DAVB', name: 'WebDAV Beta Ltd.' }, owner.email)
  const chart = `1000,Cash,asset,,cash_and_cash_equivalents\n5000,Supplies,expense,,`
  const pdfA = tinyPdf('alpha receipt')
  const pdfB = tinyPdf('beta receipt')
  for (const company of [a, b]) {
    const accounts = await importAccounts(company.company.id,
      parseAccountsCsv(chart).map((row) => ({ ...row, entityId: company.company.id })), owner.email)
    const ids = Object.fromEntries(accounts.map((account) => [account.code, account.id]))
    const year = Number(company.year.endDate.slice(0, 4))
    const entry = await postEntry({
      ledgerId: company.ledger.id, entryDate: `${year}-02-10`, description: 'Supplies', actor: owner.email,
      lines: [
        { accountId: ids['5000'], amount: parseMoney('80.00') },
        { accountId: ids['1000'], amount: -parseMoney('80.00') },
      ],
    })
    await saveAttachment({
      ledgerId: company.ledger.id, entryId: entry.entry.id,
      filename: 'receipt.pdf', bytes: company === a ? pdfA : pdfB,
      mime: 'application/pdf', actor: owner.email,
    })
  }
  const minute = await addMinuteBookEntry({
    entityId: b.company.id, recordKind: 'directors_resolution',
    onDate: `${Number(b.year.endDate.slice(0, 4))}-02-12`, title: 'Approve budget',
    keptAt: 'FigTree', actor: owner.email,
  })
  await attachToMinuteBook({
    ledgerId: b.ledger.id, minuteId: minute, filename: 'resolution.pdf',
    bytes: tinyPdf('beta resolution'), mime: 'application/pdf', actor: owner.email,
  })

  const matrix = async (enabled: boolean, includeAlpha = true) => {
    const form = new FormData()
    form.set(F.userId, user.id)
    form.set(F.grantMode, 'matrix')
    form.set(F.reason, 'Test folder permission')
    if (includeAlpha) form.append(F.grant, `${a.company.id}|/entries`)
    form.append(F.grant, `${b.company.id}|/records`)
    if (enabled) form.set(F.webdavEnabled, 'true')
    const result = await setGrantsFromForm(form, owner)
    assert.ok(result.ok, result.error)
  }
  assert.equal(user.webdav_enabled, false)
  assert.deepEqual(await webdavRights(user, a.company.id), { journal: false, records: false })
  await assert.rejects(() => rotateWebDavCredential(user, a.company.id))
  const oldSecret = 'A'.repeat(43)
  await db.execute(sql`
    INSERT INTO webdav_credential (user_id, entity_id, token_hash)
    VALUES (${user.id}::uuid, ${a.company.id}::uuid,
            ${createHash('sha256').update(oldSecret).digest('hex')})`)
  const selfGrant = new FormData()
  selfGrant.set(F.userId, user.id)
  selfGrant.set(F.grantMode, 'webdav')
  selfGrant.set(F.webdavEnabled, 'true')
  selfGrant.set(F.reason, 'Cannot grant oneself folder access')
  assert.ok((await setGrantsFromForm(selfGrant, user)).error)
  await matrix(true)
  assert.equal(await authenticateWebDav(basic(user.email, oldSecret), a.company.id), null)
  const secretA = await rotateWebDavCredential(user, a.company.id)
  const secretB = await rotateWebDavCredential(user, b.company.id)
  let authA = basic(user.email, secretA)
  let authB = basic(user.email, secretB)
  assert.equal((await webdavCredentialStatus(user.id)).size, 2)
  assert.equal((await handleWebDav(request(href(a.company.id, []), 'PROPFIND'))).status, 401)
  assert.equal((await handleWebDav(request(href(b.company.id, []), 'PROPFIND', authA))).status, 401)
  assert.equal((await handleWebDav(request(href(a.company.id, []), 'PUT', authA))).status, 405)
  assert.equal((await handleWebDav(request(href(a.company.id, []), 'OPTIONS'))).status, 204)

  const rootA = await handleWebDav(request(href(a.company.id, []), 'PROPFIND', authA, { Depth: '1' }))
  const xmlA = await rootA.text()
  assert.equal(rootA.status, 207)
  assert.match(xmlA, /Cash/)
  assert.doesNotMatch(xmlA, /blobs|Minute book/)
  const rightsA = await webdavRights(user, a.company.id)
  const filesA = await webdavFilesOf(a.company.id, rightsA)
  assert.equal(filesA.length, 2)
  const fileUrlA = href(a.company.id, filesA[0].segments)
  const fileA = await handleWebDav(request(fileUrlA, 'GET', authA))
  assert.equal(fileA.status, 200)
  assert.deepEqual(Buffer.from(await fileA.arrayBuffer()), pdfA)
  if (process.env.WEB_DAV_HTTP_BASE) {
    const liveRoot = await liveRequest(process.env.WEB_DAV_HTTP_BASE,
      a.company.id, [], 'PROPFIND', authA)
    const liveFile = await liveRequest(process.env.WEB_DAV_HTTP_BASE,
      a.company.id, filesA[0].segments, 'GET', authA)
    assert.equal(liveRoot.status, 207)
    assert.match(liveRoot.body.toString(), /Cash/)
    assert.equal(liveFile.status, 200,
      `Live WebDAV GET returned ${liveFile.status}: ${liveFile.body.toString().slice(0, 180)}`)
    assert.deepEqual(liveFile.body, pdfA)
  }
  const partial = await handleWebDav(request(fileUrlA, 'GET', authA, { Range: 'bytes=0-9' }))
  assert.equal(partial.status, 206)
  assert.deepEqual(Buffer.from(await partial.arrayBuffer()), pdfA.subarray(0, 10))
  assert.equal((await handleWebDav(request(fileUrlA, 'HEAD', authA))).status, 200)

  const rootB = await handleWebDav(request(href(b.company.id, []), 'PROPFIND', authB, { Depth: '1' }))
  const xmlB = await rootB.text()
  assert.match(xmlB, /Minute%20book|Minute book/)
  assert.doesNotMatch(xmlB, /Cash|Supplies|blobs/)
  const filesB = await webdavFilesOf(b.company.id, await webdavRights(user, b.company.id))
  assert.equal(filesB.length, 1)
  assert.deepEqual(Buffer.from(await (await handleWebDav(
    request(href(b.company.id, filesB[0].segments), 'GET', authB),
  )).arrayBuffer()), tinyPdf('beta resolution'))

  await matrix(false)
  assert.equal((await handleWebDav(request(fileUrlA, 'GET', authA))).status, 401)
  assert.equal((await handleWebDav(request(href(b.company.id, []), 'PROPFIND', authB))).status, 401)
  assert.equal((await webdavCredentialStatus(user.id)).size, 0)
  await matrix(true)
  assert.equal((await handleWebDav(request(fileUrlA, 'GET', authA))).status, 401)
  authA = basic(user.email, await rotateWebDavCredential(user, a.company.id))
  authB = basic(user.email, await rotateWebDavCredential(user, b.company.id))

  const nextSecretA = await rotateWebDavCredential(user, a.company.id)
  assert.equal((await handleWebDav(request(fileUrlA, 'GET', authA))).status, 401)
  let nextAuthA = basic(user.email, nextSecretA)
  assert.equal((await handleWebDav(request(fileUrlA, 'GET', nextAuthA))).status, 200)
  const blob = path.join(process.env.ATTACHMENTS_DIR!, 'WebDAV Alpha Ltd.', 'blobs', filesA[0].sha256)
  const original = await fs.readFile(blob)
  await fs.writeFile(blob, tinyPdf('tampered receipt'))
  assert.equal((await handleWebDav(request(fileUrlA, 'GET', nextAuthA))).status, 409)
  await fs.writeFile(blob, original)

  await matrix(true, false)
  assert.equal(await authenticateWebDav(nextAuthA, a.company.id), null)
  await matrix(true)
  assert.equal((await handleWebDav(request(fileUrlA, 'GET', nextAuthA))).status, 401)
  nextAuthA = basic(user.email, await rotateWebDavCredential(user, a.company.id))
  assert.equal((await handleWebDav(request(fileUrlA, 'GET', nextAuthA))).status, 200)
  await revokeWebDavCredential(user, b.company.id)
  assert.equal((await handleWebDav(request(href(b.company.id, []), 'PROPFIND', authB))).status, 401)
  await setPassword({
    userId: user.id, password: 'a new very long reader password', actor: owner.email,
  })
  assert.equal((await handleWebDav(request(fileUrlA, 'GET', nextAuthA))).status, 401)
  const deactivationSecret = await rotateWebDavCredential(user, a.company.id)
  const deactivationAuth = basic(user.email, deactivationSecret)
  await setUserStatus({ userId: user.id, isActive: false, actor: owner.email })
  await setUserStatus({ userId: user.id, isActive: true, actor: owner.email })
  assert.equal((await handleWebDav(request(fileUrlA, 'GET', deactivationAuth))).status, 401)
  assert.equal((await webdavCredentialStatus(user.id)).size, 0)
  const empty = await createCompanyWithYear({ code: 'DAVC', name: 'WebDAV Empty Ltd.' }, owner.email)
  await assert.rejects(() => rotateWebDavCredential(owner, empty.company.id))
  const ownerGrant = new FormData()
  ownerGrant.set(F.userId, owner.id)
  ownerGrant.set(F.grantMode, 'webdav')
  ownerGrant.set(F.webdavEnabled, 'true')
  ownerGrant.set(F.reason, 'Owner chooses folder access')
  assert.ok((await setGrantsFromForm(ownerGrant, owner)).ok)
  const emptySecret = await rotateWebDavCredential(owner, empty.company.id)
  await deleteCompany(empty.company.id, owner.email)
  assert.equal(await authenticateWebDav(basic(owner.email, emptySecret), empty.company.id), null)
  assert.equal((await webdavCredentialStatus(owner.id)).has(empty.company.id), false)
  assert.equal(createHash('sha256').update(secretA).digest('hex').length, 64)
  console.log('PASS  WebDAV opt-in, revocation, company folders, read-only methods, ranges, deletion and integrity')
  console.log('\n=== ALL CHECKS PASSED ===')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
  .finally(async () => { await conn.end() })
