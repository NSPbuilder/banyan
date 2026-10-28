import './env'
import {buildOperationsFixture} from './operations-fixture'
import {buildOperationsFinanceFixture} from './operations-finance-fixture'
import {operationsReconciliation} from '../src/lib/operations-reconciliation'
import {buildAdvancedOperationsFixture} from './advanced-operations-fixture'
import {buildP5Lifecycle} from './p5-lifecycle'
/**
 * One company in one file, and back again.
 *   npm run db:verify-backup   (resets the TEST database first)
 *
 * The owner asked for a backup menu inside the application: this company, a
 * `.fig` file, and a restore that reads one back (2026-09-07). What has
 * to be true for that to be worth having is that the company which comes out
 * is the company that went in — so the round trip is compared row for row,
 * not sampled.
 */
import { messageOf as errorText, reporter, tinyPdf as pdf } from './suite'
import { mkdtempSync } from 'fs'
import os from 'os'
import path from 'path'
import { createHash, randomUUID } from 'crypto'
import { gzipSync } from 'zlib'

process.env.ATTACHMENTS_DIR = mkdtempSync(path.join(os.tmpdir(), 'erp-backup-'))
process.env.PROJECT_ATTACHMENTS_DIR = mkdtempSync(path.join(os.tmpdir(), 'figtree-project-backup-'))

import { sql as raw } from 'drizzle-orm'
import { db, sql as conn } from '../src/db/client'
import { importAccounts } from '../src/lib/accounts'
import { buildExampleCompany } from './example-company'
import { postEntry } from '../src/lib/posting'
import { saveAttachment, attachmentsOf, readBlobBytes, attachStatementFile } from '../src/lib/attachments'
import { attachToMinuteBook, minuteBookPaperFile, minuteBookPaperOf } from '../src/modules/records/attachments'
import { execFileSync } from 'node:child_process'
import { BACKUP_EXT } from '../src/lib/backup-name'
import { parseMoney } from '../src/lib/money'
import { saveGstAdjustment } from '../src/lib/gst-adjustments'
import { createManualCheque } from '../src/lib/cheques'
import { chequePdf } from '../src/lib/cheque-pdf'
import { trialBalance } from '../src/lib/balances'
import { createFirstOwner, signIn } from '../src/lib/users'
import { setPrimaryContactEmail } from '../src/lib/parties'
import { PDFDocument } from 'pdf-lib'
import { requestActor, configureAutomation } from '../src/lib/automation-access'
import { saveRecurring, generateOccurrence } from '../src/lib/recurring'
import { uploadInbox, reviewInbox } from '../src/lib/inbox'
import { createMailPreview, queueMail, saveReminder } from '../src/lib/mail'
import { editLease } from '../src/lib/edit-leases'
import type { EditContext, EditResource } from '../src/lib/edit-proof'
import { createProject, saveProjectRecord, createProjectPayment, projectSummaries, projectProfit } from '../src/lib/project'
import { generateProjectInvoice } from '../src/lib/project-invoices'
import { setCompanyModules } from '../src/lib/company-modules'
import { MODULE_PATHS } from '../src/lib/nav'
import { saveProjectFinanceRecord, saveProjectFinancePayment } from '../src/lib/project-finance'
import { attachProjectFile, readProjectBlob, writeProjectBlob } from '../src/lib/project-attachments'
import { uploadSigningDocument } from '../src/lib/esign'
import {
  convertLead, createAccount, createActivity, createContact, createLead,
  createOpportunity, createTask, moveOpportunity,
} from '../src/lib/crm'
import {
  BackupError, COMPANY_DATA, NOT_COMPANY_DATA, UNIQUE_HANDLED, exportCompany, inspectFigtree,
  packFigtree, readFigtree, restoreCompany, restorePaper,
} from '../src/lib/backup'

import { buildP3Lifecycle,compareP3Copy,p3Proof } from './p3-lifecycle'
import { planningActor } from '../src/lib/planning-access'
import { runImportBatch,importDetail } from '../src/lib/ledger-import'
const r = reporter(57)
const { pass, fail, check } = r

/**
 * Tables `BK0` does not require rows in, and why.
 *
 * Short on purpose. Every name here is a table the round trip says nothing
 * about, so each has to be a thing a fixture genuinely cannot produce rather
 * than a thing nobody got round to.
 */
const NOT_IN_THE_FIXTURE: Record<string, string> = {
  fx_company_currency: 'CAD-only example does not opt into foreign business; foreign-policy and monetary round trips are verified by verify-fx.ts',
  // Not "nobody got round to it": there is no door in this application that
  // writes either of these. The tables exist and nothing fills them, which is
  // worth knowing and is why the reason is written out rather than assumed.
  dimension: 'no screen in this application creates one yet',
  dimension_value: 'the same',
  officer_position: 'no screen in this application appoints one yet',
}

async function main() {
  // These prerequisite restores feed later comparisons. A rejected valid
  // fixture is an assertion failure, just like the guarded BK2b round trip.
  async function prerequisiteRestore(label: string, ...args: Parameters<typeof restoreCompany>) {
    try { return await restoreCompany(...args) } catch (e) {
      fail(label, errorText(e).slice(0, 200))
      console.log(r.summary())
      await conn.end()
      process.exit(1)
    }
  }
  // BK1 — NO TABLE FORGOTTEN. A backup that quietly leaves a table out is
  //       worse than no backup: it restores, it looks complete, and one
  //       module is empty. Every table in the database must be named as this
  //       company's data or declared not to be, with a reason.
  const tables = (await db.execute<{ table_name: string }>(raw`
    SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     ORDER BY table_name`)).map((t) => t.table_name)
  const named = new Set([...COMPANY_DATA.map((c) => c.table), ...Object.keys(NOT_COMPANY_DATA)])
  const forgotten = tables.filter((t) => !named.has(t))
  const invented = [...named].filter((t) => !tables.includes(t))
  check(forgotten.length === 0 && invented.length === 0,
    'BK1 every table in the database is backed up or declared not to be',
    forgotten.length + invented.length === 0
      ? `${tables.length} tables: ${COMPANY_DATA.length} carried, ${Object.keys(NOT_COMPANY_DATA).length} declared out`
      : `forgotten: ${forgotten.join(' ')} | named but absent: ${invented.join(' ')}`)
  // A complete table inventory is a precondition for the restore fixtures.
  // Report its explicit failure before later database constraints reject an
  // incomplete restore and hide the diagnostic summary from mutation runs.
  if (forgotten.length || invented.length) {
    console.log(r.summary())
    await conn.end()
    process.exit(1)
  }

  // BK1b — AND NO UNIQUE VALUE COPIED VERBATIM. Twice now a restore has died
  //        on a value the whole table has to agree on: first the ids, then
  //        `journal_entry.idempotency_key`. A unique index is safe here only
  //        if one of its columns is something the restore REMAPS — the row's
  //        own id, or a foreign key to something carried. Anything else has
  //        to be named, with what is done about it instead.
  const carried = new Set(COMPANY_DATA.map((c) => c.table))
  const uniques = await db.execute<{
    table_name: string; index_name: string; cols: string[]; is_expression: boolean
  }>(raw`
    SELECT c.relname AS table_name, i.relname AS index_name,
           COALESCE(array_agg(a.attname) FILTER (WHERE a.attname IS NOT NULL), '{}') AS cols,
           (x.indexprs IS NOT NULL) AS is_expression
      FROM pg_index x
      JOIN pg_class c ON c.oid = x.indrelid
      JOIN pg_class i ON i.oid = x.indexrelid
      LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(x.indkey)
     WHERE x.indisunique AND c.relnamespace = 'public'::regnamespace
     GROUP BY c.relname, i.relname, x.indexprs`)
  // Which columns carry a value the restore rewrites: the row's own id, and
  // every foreign key pointing at a table whose ids are remapped.
  const remapped = await db.execute<{ table_name: string; column_name: string }>(raw`
    SELECT c.relname AS table_name, a.attname AS column_name
      FROM pg_constraint k
      JOIN pg_class c ON c.oid = k.conrelid
      JOIN pg_class cf ON cf.oid = k.confrelid
      JOIN unnest(k.conkey) AS ck(attnum) ON true
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ck.attnum
     WHERE k.contype = 'f' AND c.relnamespace = 'public'::regnamespace`)
  const rewrites = new Map<string, Set<string>>()
  for (const r of remapped) {
    if (!rewrites.has(r.table_name)) rewrites.set(r.table_name, new Set(['id']))
    rewrites.get(r.table_name)!.add(r.column_name)
  }
  const unhandled = uniques
    .filter((u) => carried.has(u.table_name) || u.table_name === 'entity' || u.table_name === 'party')
    .filter((u) => !(u.index_name in UNIQUE_HANDLED))
    .filter((u) => u.is_expression
      || !u.cols.some((c) => c === 'id' || rewrites.get(u.table_name)?.has(c)))
    .map((u) => `${u.index_name} (${u.is_expression ? 'an expression' : u.cols.join(',')})`)
  check(unhandled.length === 0,
    'BK1b every unique value a restore copies is one the restore rewrites, or is named',
    unhandled.length === 0
      ? `${uniques.length} unique indexes, ${Object.keys(UNIQUE_HANDLED).length} named`
      : unhandled.join(' | '))

  // -------------------------------------------- a company worth restoring --
  //
  // THE EXAMPLE COMPANY, not a hand-built one. A round trip over three
  // entries and no invoice passes, and then a real restore dies on the first
  // posted invoice it meets — which is how two of these reached the owner
  // (2026-09-07). `buildExampleCompany` is the same fixture `db:example`
  // leaves for them to explore: registrations, an opening balance, sales and
  // purchase invoices, a credit note applied, payments, quick entries, a
  // reversal pair, a bank import with a match and an ignored row, corporate
  // records, shares issued, and January closed.
  const ACTOR = 'alicio@example.test'
  const DELETED_SOURCE_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  const demo = await buildExampleCompany({ code: 'BKP', name: 'Backup Books Ltd.', actor: ACTOR })
  const L = demo.ledgerId
  const E = demo.entityId
  const id = demo.accounts
  await saveGstAdjustment(L,ACTOR,{from:'2026-01-01',to:'2026-03-31',version:0,
    sales:'',collected:'123.45',itcs:'',reason:'Reviewed GST working-copy fixture'})
  await createManualCheque({ ledgerId: L, bankAccountId: id['1000'],
    expenseAccountId: id['5200'], chequeDate: '2026-07-20', payee: 'Office Store',
    amount: 1750n, memo: 'Backup fixture', actor: ACTOR, startingNumber: 2001n })

  // Two shapes the example happens not to have, added the way anything is
  // added here — through a door.
  //
  // A PARENT ACCOUNT: `account.parent_id` points back at its own table, and
  // rows go in as they were read (block 525).
  const [child] = await importAccounts(E, [{
    entityId: E, code: '5250', name: 'Stationery', accountType: 'expense',
    parentCode: '5200', isPostable: true, roles: [],
  }], ACTOR)

  // AN ENTRY CARRYING AN IDEMPOTENCY KEY: the quick forms mint one per page
  // load so a double click is one entry, and it is unique across the whole
  // table. A fixture with none passed while a real restore died on it
  // (`journal_entry_idempotency_key_key`, owner, 2026-09-07).
  const keyed = await postEntry({
    idempotencyKey: 'the-same-payday-twice',
    ledgerId: L, entryDate: '2026-07-20', description: 'Stationery, keyed once', actor: ACTOR,
    lines: [
      { accountId: child.id, amount: parseMoney('42.00') },
      { accountId: id['1000'], amount: -parseMoney('42.00') },
    ],
  })

  // AND PAPER, for the half of a backup that is not rows.
  await saveAttachment({
    ledgerId: L, entryId: keyed.entry.id, filename: 'receipt.pdf',
    bytes: pdf('the paper behind it'), mime: 'application/pdf', actor: ACTOR,
  })

  // And the minute book's paper (0081): the example's resolution, with bytes of
  // its OWN — the same bytes as the receipt would be carried by the receipt,
  // and a backup that forgot the minute book's blobs would pass unnoticed.
  const [minute] = await db.execute<{ id: string }>(raw`
    SELECT id::text FROM minute_book_entry WHERE entity_id = ${E}::uuid ORDER BY on_date LIMIT 1`)
  await attachToMinuteBook({
    ledgerId: L, minuteId: minute.id, filename: 'resolution.pdf',
    bytes: pdf('the signed resolution itself'), mime: 'application/pdf', actor: ACTOR,
  })
  const [statement] = await db.execute<{ id: string }>(raw`
    SELECT id::text FROM bank_statement WHERE account_id = ${id['1000']}::uuid ORDER BY statement_date LIMIT 1`)
  await attachStatementFile({ ledgerId: L, accountId: id['1000'], statementId: statement.id,
    filename: 'bank-statement.pdf', bytes: pdf('the original bank statement'), actor: ACTOR })

  // AND THE ASSISTANT'S RECORDS, which are rows like any other: an exchange, a
  // bill reading that points at it, and a question to the books with a look-up
  // and an answer. Asking needs a service and a key; a row does not, so these
  // go in directly.
  const [exchange] = await db.execute<{ id: string }>(raw`
    INSERT INTO ai_exchange (ledger_id, asked_by, model, question, answer, stop_reason)
    VALUES (${L}::uuid, ${ACTOR}, 'stub-model', 'What is owed?', 'Nothing.', 'end_turn')
    RETURNING id::text`)
  await db.execute(raw`
    INSERT INTO ai_bill_reading (ledger_id, read_by, filename, mime, bytes, sha256, exchange_id)
    VALUES (${L}::uuid, ${ACTOR}, 'bill.pdf', 'application/pdf', '\\x00'::bytea, ${'d'.repeat(64)}, ${exchange.id}::uuid)`)
  // And one from a sentence alone (0077): no file columns at all.
  await db.execute(raw`
    INSERT INTO ai_bill_reading (ledger_id, read_by, sentence)
    VALUES (${L}::uuid, ${ACTOR}, 'Received 80.00 from Quayside Moorage for September')`)
  const [inquiry] = await db.execute<{ id: string }>(raw`
    INSERT INTO ai_inquiry (ledger_id, asked_by, question, system, model)
    VALUES (${L}::uuid, ${ACTOR}, 'Who owes us?', 'the system text', 'stub-model')
    RETURNING id::text`)
  await db.execute(raw`
    INSERT INTO ai_inquiry_skill (inquiry_id, skill, route_reason, request, system)
    VALUES (${inquiry.id}::uuid, 'crm', 'fixture route', 'Add a test lead', 'the CRM system text')`)
  await db.execute(raw`
    INSERT INTO ai_inquiry_step (inquiry_id, n, outcome, model_text, tool, args, result)
    VALUES (${inquiry.id}::uuid, 1, 'call', '{"call":"crm_draft_lead","args":{"organisation_name":"Backup Fixture"}}', 'crm_draft_lead',
            '{"organisation_name":"Backup Fixture"}'::jsonb, ${`CRM proposal — not saved. Link /ledger/${L}/parties/somebody`}),
           (${inquiry.id}::uuid, 2, 'answer', '{"answer":"Nobody owes us."}', NULL, NULL, NULL)`)
  await db.execute(raw`
    INSERT INTO ai_skill_command_execution (inquiry_id, step_n, entity_id, executed_by, tool)
    VALUES (${inquiry.id}::uuid, 1, ${E}::uuid, ${ACTOR}, 'crm_draft_lead')`)

  // Somebody this company deals with, for the party checks. Taken from the
  // example rather than invented, because the example is what is restored.
  const [supplier] = await db.execute<{ id: string; name: string }>(raw`
    SELECT p.id::text, p.name FROM party p
      JOIN party_role pr ON pr.party_id = p.id
     WHERE pr.entity_id = ${E}::uuid AND pr.role = 'supplier'
     ORDER BY p.name LIMIT 1`)

  // CRM rows exercise the portable relationship layer too. The Party remains
  // shared, while every CRM row and its audit history belongs to this company.
  // This is deliberately built through the same doors as the screen; an empty
  // new table makes a row-count round trip prove nothing (BK0).
  const owner = await createFirstOwner({
    email: ACTOR, firstName: 'Alicio', password: 'a long backup password',
  })
  await buildAdvancedOperationsFixture(owner,L)
  await buildOperationsFixture(owner,L)
  const supplierAccount = await createAccount({
    ledgerId: L, partyId: supplier.id, lifecycle: 'active', ownerUserId: owner.id,
    source: 'Backup fixture', actor: ACTOR,
  })
  const lead = await createLead({
    ledgerId: L, organisationName: 'Portable Prospect Ltd.', personName: 'Piper Prospect',
    email: 'piper@example.test', source: 'Referral', ownerUserId: owner.id, actor: ACTOR,
  })
  await convertLead({ ledgerId: L, leadId: lead.id, version: 1, actor: ACTOR, actorUserId: owner.id })
  await createContact({
    ledgerId: L, accountId: supplierAccount.id, name: 'Sam Supplier',
    email: 'sam@example.test', isPrimary: true, actor: ACTOR,
  })
  const opportunity = await createOpportunity({
    ledgerId: L, accountId: supplierAccount.id, name: 'Portable engagement',
    ownerUserId: owner.id, expectedAmount: 125000n, probabilityBp: 6000,
    expectedCloseOn: '2026-10-31', actor: ACTOR,
  })
  await createActivity({
    ledgerId: L, targetKind: 'account', targetId: supplierAccount.id, kind: 'meeting',
    subject: 'Discovery meeting', actor: ACTOR, actorUserId: owner.id,
  })
  await createTask({
    ledgerId: L, targetKind: 'opportunity', targetId: opportunity.id,
    assignedUserId: owner.id, title: 'Send proposal', actor: ACTOR,
  })
  const [won] = await db.execute<{ id: string }>(raw`
    SELECT id::text FROM crm_stage
     WHERE entity_id = ${E}::uuid AND kind = 'won' LIMIT 1`)
  await moveOpportunity({
    ledgerId: L, opportunityId: opportunity.id, stageId: won.id, version: 1,
    reason: 'Accepted proposal', actor: ACTOR,
  })
  const [receipt] = await db.execute<{ sha256: string }>(raw`
    SELECT sha256 FROM attachment WHERE entry_id = ${keyed.entry.id}::uuid LIMIT 1`)
  await db.execute(raw`
    INSERT INTO crm_attachment (entity_id, account_id, sha256, original_name, note, created_by)
    VALUES (${E}::uuid, ${supplierAccount.id}::uuid, ${receipt.sha256},
            'relationship-note.pdf', 'Shared test paper', ${ACTOR})`)

  const lastPeriod = async (ledgerId: string) => (await db.execute<{ id: string }>(raw`
    SELECT id::text FROM fiscal_period WHERE ledger_id = ${ledgerId}::uuid
     ORDER BY start_date DESC LIMIT 1`))[0].id

  // A legacy-shaped row whose private keys pre-date the redaction trigger.
  // Export has to scrub it without rewriting the stored evidence, while the
  // ordinary fields prove actor/time/content and id mapping on restore.
  await db.transaction(async (tx) => {
    await tx.execute(raw`SET LOCAL session_replication_role = 'replica'`)
    await tx.execute(raw`
      INSERT INTO audit_log
        (occurred_at, actor, action, table_name, record_id, before, after, context,
         entity_id, ledger_id, scope, reason, target_label)
      VALUES
        ('2025-01-02 03:04:05+00', 'source.auditor@example.test', 'portable_provenance_test',
         'journal_entry', ${keyed.entry.id},
         '{"memo":"before","api_key":"legacy-secret"}'::jsonb,
         '{"memo":"after"}'::jsonb,
         '{"request":"=SUM(A1:A2)","token":"legacy-token"}'::jsonb,
         ${E}::uuid, ${L}::uuid, 'company', 'Portable audit proof', 'JE source'),
        ('2025-01-03 03:04:05+00', 'source.auditor@example.test', 'hard_delete',
         'journal_entry', ${DELETED_SOURCE_ID},
         '{"entry_no":999,"description":"Deleted before export"}'::jsonb,
         NULL, '{"reason":"Entered in error"}'::jsonb,
         ${E}::uuid, ${L}::uuid, 'company', 'Entered in error', 'JE-0999')`)
  })

  // BK0 — THE FIXTURE ITSELF. Every table a backup carries has rows in the
  const [projectCustomer]=await db.execute<{id:string}>(raw`SELECT party_id::text AS id FROM party_role WHERE entity_id=${E}::uuid AND role='customer' LIMIT 1`)
  const projectId=await createProject({entityId:E,currency:'CAD',code:'BK-SITE',name:'Portable site costing',customerPartyId:projectCustomer.id,actor:ACTOR})
  const projectRecord=await saveProjectRecord({entityId:E,projectId,partyId:projectCustomer.id,kind:'revenue',date:'2026-07-01',description:'Project revenue',actor:ACTOR,key:'backup-project-record',lines:[{kind:'revenue',description:'Scope',base:10000n,gst:500n,pst:0n,gstRecoverable:null,pstRecoverable:null}]})
  await createProjectPayment({entityId:E,projectId,partyId:projectCustomer.id,direction:'received',date:'2026-07-02',amount:5000n,recordId:projectRecord,key:'backup-project-receipt',actor:ACTOR})
  const taxAccount=async(role:string)=>(await db.execute<{id:string}>(raw`SELECT a.id::text FROM account a JOIN account_role ar ON ar.account_id=a.id WHERE a.entity_id=${E}::uuid AND ar.role=${role} LIMIT 1`))[0]?.id
  const gstPayable=await taxAccount('gst_hst_payable')
  await setCompanyModules(owner,{entityId:E,modules:MODULE_PATHS})
  await generateProjectInvoice(owner,{ledgerId:L,projectId,recordId:projectRecord,version:1,issuedOn:'2026-07-01',dueOn:'2026-07-31',controlAccountId:id['1200'],revenueAccountIds:[id['4000']],gstAccountId:gstPayable})
  const linkedProject=await createProject({entityId:E,currency:'CAD',code:'BK-AUTO',name:'Portable automatic accounting',customerPartyId:projectCustomer.id,actor:ACTOR})
  const managedRecord=await saveProjectFinanceRecord(owner,{entityId:E,ledgerId:L,projectId:linkedProject,partyId:projectCustomer.id,kind:'revenue',date:'2026-07-01',description:'Automatic project revenue',actor:ACTOR,key:randomUUID(),
    accountIds:[id['4000']],controlAccountId:id['1200'],gstAccountId:gstPayable,
    lines:[{kind:'revenue',description:'Scope',base:10000n,gst:500n,pst:0n,gstRecoverable:null,pstRecoverable:null}]})
  await saveProjectFinancePayment(owner,{entityId:E,ledgerId:L,projectId:linkedProject,partyId:projectCustomer.id,direction:'received',date:'2026-07-02',amount:5000n,recordId:managedRecord,key:randomUUID(),actor:ACTOR,bankAccountId:id['1000']})
  const projectBytes=pdf('Project independent file domain')
  const projectSha=createHash('sha256').update(projectBytes).digest('hex')
  await attachProjectFile({entityId:E,projectId,recordId:projectRecord,filename:'site-proof.pdf',mime:'application/pdf',bytes:projectBytes,actor:ACTOR})
  const before = await trialBalance(L, await lastPeriod(L))
  const signingDocumentId=await uploadSigningDocument({entityId:E,title:'Portable signing history',kind:'contract',submissionKey:randomUUID(),filename:'signing-source.pdf',bytes:pdf('Synthetic signing source'),actor:ACTOR})
  await db.execute(raw`INSERT INTO esign_request(entity_id,document_id,created_by) VALUES(${E}::uuid,${signingDocumentId}::uuid,${ACTOR})`)
  // P2 is populated through the real authenticated business doors. No worker
  // is started and no SMTP provider is contacted by this portable-backup fixture.
  const session=await signIn({email:ACTOR,password:'a long backup password',clientIp:'192.0.2.80'})
  const automationActor=requestActor(session.token)
  process.env.AUTOMATION_ENABLED='true'
  await configureAutomation(L,automationActor,{version:'0',enabled:true,mailEnabled:true,timezone:'America/Vancouver',senderEmail:'backup@example.test'})
  const edit=async(resource:EditResource):Promise<EditContext>=>{
    const tabId=randomUUID(),lease=await editLease(resource,session.token,'takeover',{version:'1',tabId})
    return {sessionToken:session.token,proof:{version:'1',tabId,...lease},leaseRequired:true}
  }
  const template=await saveRecurring(L,automationActor,{sourceId:keyed.entry.id,documentType:'entry',title:'Portable recurring draft',rule:{frequency:'monthly',dayMode:'fixed',anchorDate:'2026-07-20',dayOfMonth:20},dueDays:0,active:true})
  await generateOccurrence(L,template.id,'2026-07-20',automationActor,await edit({ledgerId:L,type:'recurring',id:template.id}))
  const originalPdf=await PDFDocument.create();originalPdf.addPage().drawText('Portable Inbox original')
  const inboxBytes=Buffer.from(await originalPdf.save())
  const inbox=await uploadInbox(L,automationActor,{name:'portable-original.pdf',type:'application/pdf',bytes:inboxBytes},false)
  const linking=new FormData();linking.set('operation','link');linking.set('linkType','entry');linking.set('targetId',keyed.entry.id)
  await reviewInbox(L,inbox.id,automationActor,await edit({ledgerId:L,type:'inbox',id:inbox.id}),linking)
  const [formal]=await db.execute<{id:string;party_id:string}>(raw`SELECT id::text,party_id::text FROM invoice WHERE ledger_id=${L}::uuid AND direction='sales' AND status='posted' AND NOT EXISTS(SELECT 1 FROM project_invoice_handoff h WHERE h.invoice_id=invoice.id) ORDER BY issued_on LIMIT 1`)
  await setPrimaryContactEmail(formal.party_id,'customer@example.test',ACTOR)
  await saveReminder(L,automationActor,{partyId:formal.party_id,enabled:false,paused:false,reason:'',days:[7,30],startHour:9,endHour:17})
  const approved=await createMailPreview(L,automationActor,{kind:'invoice',partyId:formal.party_id,invoiceId:formal.id,asOf:'2026-07-20',to:'customer@example.test',cc:[],subject:'Portable approved invoice',body:'Review the attached invoice.',requestKey:randomUUID()})
  await queueMail(L,approved.id,automationActor)
  process.env.AUTOMATION_ENABLED='false'
  // Every table a backup carries has rows in the
  //       company about to be restored, or is named with the reason it
  //       cannot have any.
  //
  //       This is the check that would have caught all four of the restore
  //       failures that reached the owner (2026-09-07). Every one of them was
  //       a table the round trip left empty: no posted invoice, no entry with
  //       an idempotency key, no payroll. A comparison over an empty table
  //       passes and proves nothing, and it looks exactly like a comparison
  //       that proves something.
  const counted = await db.execute<{ t: string; n: string }>(raw`
    SELECT 'x' AS t, '0' AS n WHERE false`)
  void counted
  const p3=await buildP3Lifecycle(ACTOR,session.token,'BKP3IMPORT')
  const p3Doc=await exportCompany(p3.entityId,{withFiles:true})
  const p5=await buildP5Lifecycle(ACTOR,session.token,'BKP5PROTO'),p5Doc=await exportCompany(p5.entityId,{withFiles:true})
  const ops=await buildOperationsFinanceFixture(owner,'BKOPFIN'),opsDoc=await exportCompany(ops.entityId)
  const opsCopy=await prerequisiteRestore('BK-OPS valid financial operations backup restores beside its source',opsDoc,ACTOR,{code:'BKOPCOPY',name:'Restored financial operations'})
  check((await operationsReconciliation(opsCopy.ledgerId!,'/assets','2026-12-31')).every(r=>r.difference==='0')&&(await operationsReconciliation(opsCopy.ledgerId!,'/inventory','2026-12-31')).every(r=>r.difference==='0'),'BK-OPS all finance source journals and payroll allocations restore with their daily controls')
  const empty: string[] = []
  {
    const probe = await exportCompany(E)
    for (const { table } of COMPANY_DATA) {
      if ((probe.rows[table]?.length ?? 0) === 0 && (p3Doc.rows[table]?.length ?? 0)===0 && (p5Doc.rows[table]?.length??0)===0 && (opsDoc.rows[table]?.length??0)===0 && !(table in NOT_IN_THE_FIXTURE)) empty.push(table)
    }
  }
  check(empty.length === 0,
    'BK0 all carried tables populated across business, migration, local P5 and financial operations fixtures',
    empty.length === 0
      ? `${COMPANY_DATA.length - Object.keys(NOT_IN_THE_FIXTURE).length} tables exercised, `
        + `${Object.keys(NOT_IN_THE_FIXTURE).length} named as impossible here`
      : `nothing to restore in: ${empty.join(' ')}`)

  // ---------------------------------------------------------- the round trip --
  const p3Restored=await prerequisiteRestore('BK-P3 valid migration lifecycle backup restores beside its source',p3Doc,ACTOR,{code:'BKP3RESTORED',name:'BKP3 restored isolated lifecycle'})
  await restorePaper(p3Doc,p3Restored.name,p3Restored.ledgerId,p3Restored)
  const p3After=await exportCompany(p3Restored.entityId,{withFiles:true}),p3Differences=compareP3Copy(p3Doc,p3After)
  check(p3Differences.length===0,'BK-P3-1 all P3 and financial fields survive documented identity/approval reset',p3Differences.join('; '))
  // BK-P3-1b — and that answer must not depend on the order rows came back in.
  // The restored copy has new UUIDs, so any index the planner reads can return
  // its rows in another order; BK-P3-1 failed on CI that way with nothing wrong.
  const p3Reversed={...p3After,rows:Object.fromEntries(Object.entries(p3After.rows).map(([t,rows])=>[t,[...rows].reverse()]))}
  const p3ReversedDifferences=compareP3Copy(p3Doc,p3Reversed)
  check(p3ReversedDifferences.length===0,'BK-P3-1b the comparison pairs rows by what they hold, not by scan order',p3ReversedDifferences.join('; '))
  const [p3Run]=p3After.rows.migration_run
  check(p3Run.status==='restored_paused'&&p3Run.actor_user_id===null,'BK-P3-2 incomplete restored migration is paused and has no inherited user authorization')
  check(p3After.files.filter(f=>p3Doc.files.some(s=>s.sha256===f.sha256)).length===p3Doc.files.length,'BK-P3-3 private CSV source bytes restore with their original hashes')
  const p3Resource:EditResource={ledgerId:p3Restored.ledgerId!,type:'migration',id:String(p3Run.id)}
  let p3Refused=false;try{await runImportBatch(p3Resource.ledgerId,p3Resource.id,planningActor(session.token),await p3Proof(p3Resource,session.token))}catch(e){p3Refused=errorText(e).includes('restored source digest')}
  check(p3Refused,'BK-P3-4 restored checkpoints cannot continue without explicit source reapproval')
  const p3Current=await importDetail(p3Resource.ledgerId,p3Resource.id,planningActor(session.token))
  const p3Resumed=await runImportBatch(p3Resource.ledgerId,p3Resource.id,planningActor(session.token),await p3Proof(p3Resource,session.token),p3Current.digest)
  check(p3Resumed.completed===1&&p3Resumed.remaining===0&&!!p3Resumed.reconciliation?.ok,'BK-P3-5 reauthorized copy resumes only the missing application and reconciles')

  const doc = await exportCompany(E, { withFiles: true })
  const packed = await packFigtree(doc)
  const read = readFigtree(packed)

  check(read.checksum === doc.checksum && read.counts.journal_entry === doc.counts.journal_entry,
    'BK2 what is written is what is read back',
    `${(packed.length / 1024).toFixed(1)} kB packed, ${doc.counts.journal_entry} entries, ${doc.files.length} file(s)`)

  const portableAudit = read.audit?.rows.find((row) => row.action === 'portable_provenance_test')
  check(read.figtree === 4 && !!read.auditProof && !!portableAudit
      && read.audit?.rows.every((row) => row.scope === 'company' && row.entity_id === E) === true
      && (portableAudit.before as { api_key?: string })?.api_key === '[redacted]'
      && (portableAudit.context as { token?: string })?.token === '[redacted]',
    'BK2a format 4 carries company audit/source chain proof and scrubs private fields',
    portableAudit
      ? `${read.audit?.rows.length} company event(s); private fields ${
        (portableAudit.before as { api_key?: string }).api_key}/${
        (portableAudit.context as { token?: string }).token}`
      : 'the provenance event is missing')

  // GUARDED. A mutation that breaks the restore must redden a line, not end
  // the suite with a stack trace where its red line belongs (mutations.sh).
  let restored: Awaited<ReturnType<typeof restoreCompany>> | null = null
  try {
    restored = await restoreCompany(read, 'alicio@example.test',
      { code: 'BKP2', name: 'Backup Books Ltd. (restored)' })
    await restorePaper(read, 'Backup Books Ltd. (restored)', restored.ledgerId, restored)
    pass('BK2b the file restores into a company of its own', `${restored.code} ${restored.name}`)
  } catch (e) {
    const chain: string[] = []
    for (let cur: unknown = e, i = 0; cur && i < 5; i++) {
      const err = cur as { message?: string; constraint_name?: string; cause?: unknown }
      if (err.constraint_name) chain.push(err.constraint_name)
      else if (err.message) chain.push(err.message.split('\n')[0])
      cur = err.cause
    }
    fail('BK2b the file restores into a company of its own', chain.join(' | ').slice(0, 200))
  }

  // BK3 — ROW FOR ROW. Counting rows would pass on a table restored empty
  //       into a company that happened to have none; this compares what the
  //       tables hold, with the ids and the company's own name taken out
  //       because those are exactly what a restore is supposed to change.
  const shape = async (entityId: string) => {
    const out: Record<string, number> = {}
    const again = await exportCompany(entityId)
    for (const [t, rows] of Object.entries(again.rows)) out[t] = rows.length
    return { counts: out, doc: again }
  }
  const after = restored ? await shape(restored.entityId) : { counts: {} as Record<string, number> }
  const differing = Object.keys(doc.counts).filter((t) => doc.counts[t] !== after.counts[t])
  check(differing.length === 0,
    'BK3 every table comes back holding what it held',
    differing.length === 0
      ? `${COMPANY_DATA.length} tables, ${Object.values(doc.counts).reduce((a, b) => a + b, 0)} rows`
      : `${differing.length} table(s) differ: `
        + differing.slice(0, 4).map((t) => `${t} ${doc.counts[t]} → ${after.counts[t] ?? 'nothing'}`).join(', ')
        + (differing.length > 4 ? ' …' : ''))
  const [restoredCheque] = restored ? await db.execute<{ id: string; number: string; amount: string; last_number: string; source_status: string }>(raw`
    SELECT c.id::text, c.number::text, c.amount::text, s.last_number::text,
           je.status AS source_status
      FROM cheque c JOIN cheque_sequence s ON s.bank_account_id = c.bank_account_id
      JOIN journal_entry je ON je.id = c.entry_id
     WHERE c.ledger_id = ${restored.ledgerId}::uuid AND c.source_kind = 'manual'`) : []
  check(!!restoredCheque && restoredCheque.number === '2001'
      && restoredCheque.last_number === '2001' && restoredCheque.amount === '1750'
      && restoredCheque.source_status === 'posted'
      && !!restored?.ledgerId && !!(await chequePdf(restored.ledgerId, restoredCheque.id)),
    'BK3a restored cheque still points to its expense, keeps the next number and prints')

  // BK3b — a question to the books comes back on the restored company with its
  //        steps pointing at the restored question, the original keeping its
  //        own, and the text they carry unchanged — ids inside text are not
  //        rewritten, so a link in it still names the original ledger.
  {
    const [q] = restored ? await db.execute<{ id: string; steps: string; kept: string; result: string | null }>(raw`
      SELECT q.id::text,
             (SELECT count(*) FROM ai_inquiry_step s WHERE s.inquiry_id = q.id)::text AS steps,
             (SELECT count(*) FROM ai_inquiry_step s WHERE s.inquiry_id = ${inquiry.id}::uuid)::text AS kept,
             (SELECT s.result FROM ai_inquiry_step s WHERE s.inquiry_id = q.id AND s.n = 1) AS result
        FROM ai_inquiry q JOIN ledger l ON l.id = q.ledger_id
       WHERE l.entity_id = ${restored.entityId}::uuid`) : []
    check(!!q && q.id !== inquiry.id && q.steps === '2' && q.kept === '2'
          && (q.result ?? '').includes(`/ledger/${L}/parties/somebody`),
      'BK3b a question to the books comes back with its steps on the restored question and its text as it went out',
      q ? `restored question ${q.id === inquiry.id ? 'kept the SAME id' : 'has a new id'}; ${q.steps} steps on it; `
          + `${q.kept} still on the original; link ${(q.result ?? '').includes(`/ledger/${L}/`) ? 'unchanged' : 'changed'}`
        : 'no question in the restored company')
  }

  // BK3c — a reading from a sentence alone comes back with its sentence and
  //        nothing in the four file columns: null restores as null.
  {
    const rows = restored ? await db.execute<{ sentence: string | null; filename: string | null; mime: string | null; no_bytes: boolean; sha256: string | null }>(raw`
      SELECT r.sentence, r.filename, r.mime, r.bytes IS NULL AS no_bytes, r.sha256
        FROM ai_bill_reading r JOIN ledger l ON l.id = r.ledger_id
       WHERE l.entity_id = ${restored.entityId}::uuid AND r.sentence IS NOT NULL`) : []
    check(rows.length === 1 && rows[0].sentence === 'Received 80.00 from Quayside Moorage for September'
          && rows[0].filename === null && rows[0].mime === null && rows[0].no_bytes && rows[0].sha256 === null,
      'BK3c a reading from a sentence alone comes back with its sentence and no file',
      rows.length === 0 ? 'no sentence-only reading in the restored company'
        : `${rows.length} row(s); sentence ${rows[0].sentence === 'Received 80.00 from Quayside Moorage for September' ? 'kept' : rows[0].sentence}; `
          + `file columns ${rows[0].filename}/${rows[0].mime}/${rows[0].no_bytes}/${rows[0].sha256}`)
  }

  // BK3d — historical evidence is evidence, not a freshly-created event.
  // Actor/time/before/after remain the source values; the locator columns name
  // the restored company and row, while the provenance chain retains the old
  // ids and the exact file which joined the two.
  {
    const [restoredKeyed] = restored ? await db.execute<{ id: string }>(raw`
      SELECT id::text FROM journal_entry
       WHERE ledger_id = ${restored.ledgerId}::uuid AND description = 'Stationery, keyed once'`) : []
    const [event] = restored ? await db.execute<{
      occurred_at: string; actor: string; record_id: string; entity_id: string; ledger_id: string | null
      before: { memo?: string; api_key?: string }; after: { memo?: string }
      context: { request?: string; token?: string; _figtree_restore_chain?: Array<Record<string, unknown>> }
    }>(raw`
      SELECT occurred_at::text, actor, record_id, entity_id::text, ledger_id::text,
             before, after, context
        FROM audit_log
       WHERE entity_id = ${restored.entityId}::uuid AND action = 'portable_provenance_test'`) : []
    const hop = event?.context._figtree_restore_chain?.at(-1)
    check(!!event && !!restoredKeyed
        && new Date(event.occurred_at).toISOString() === '2025-01-02T03:04:05.000Z'
        && event.actor === 'source.auditor@example.test'
        && event.record_id === restoredKeyed.id
        && event.entity_id === restored?.entityId && event.ledger_id === restored?.ledgerId
        && event.before.memo === 'before' && event.before.api_key === '[redacted]'
        && event.after.memo === 'after' && event.context.request === '=SUM(A1:A2)'
        && event.context.token === '[redacted]'
        && hop?.sourceAuditId === portableAudit?.id
        && hop?.sourceEntityId === E && hop?.sourceLedgerId === L
        && hop?.sourceRecordId === keyed.entry.id && hop?.sourceFileChecksum === read.checksum,
      'BK3d audit evidence keeps its source values while its locators are remapped with provenance',
      event
        ? `${event.actor} at ${event.occurred_at}; record ${event.record_id === restoredKeyed?.id ? 'mapped' : 'wrong'}; source ${String(hop?.sourceAuditId ?? 'missing')}`
        : 'the source audit event did not come back')
  }

  // BK3e — a deleted target has no restored row and therefore no honest new
  // id. Its source id stays as the durable locator, while company/ledger move
  // to the restored books and the target label/before image explain what it
  // was. Inventing a fresh id here would imply a record exists when it does not.
  {
    const [event] = restored ? await db.execute<{
      record_id: string; entity_id: string; ledger_id: string | null; target_label: string | null
      before: { entry_no?: string; description?: string }
      context: { _figtree_restore_chain?: Array<Record<string, unknown>> }
    }>(raw`
      SELECT record_id, entity_id::text, ledger_id::text, target_label, before, context
        FROM audit_log
       WHERE entity_id = ${restored.entityId}::uuid
         AND action = 'hard_delete' AND record_id = ${DELETED_SOURCE_ID}`) : []
    const hop = event?.context._figtree_restore_chain?.at(-1)
    check(!!event && event.record_id === DELETED_SOURCE_ID
        && event.entity_id === restored?.entityId && event.ledger_id === restored?.ledgerId
        && event.target_label === 'JE-0999' && event.before.entry_no === '999'
        && hop?.sourceRecordId === DELETED_SOURCE_ID,
      'BK3e a deleted target keeps its source locator and explanation instead of inventing a restored row',
      event
        ? `${event.target_label} keeps ${event.record_id}; company/ledger remapped`
        : 'the deleted-target event did not come back')
  }

  // BK4 — and the FIGURES come back, which is the only thing a person will
  //       check. Compared through the report rather than through the rows.
  const restoredTb = restored?.ledgerId
    ? await trialBalance(restored.ledgerId, await lastPeriod(restored.ledgerId))
    : []
  const line = (rows: ReadonlyArray<{ code: string; debit: string; credit: string; balance: string }>) =>
    rows.map((r) => `${r.code}:${r.debit}/${r.credit}/${r.balance}`).join(' ')
  check(before.length > 0 && line(before) === line(restoredTb),
    'BK4 the restored books show the same trial balance',
    line(before) === line(restoredTb)
      ? `${before.length} accounts, same debits, credits and closing balances`
      : `was ${line(before).slice(0, 70)} | now ${line(restoredTb).slice(0, 70) || 'nothing'}`)

  // BK5 — the CLOSED month is closed again. Restoring it as open would leave
  //       a company whose filed months are quietly editable.
  const [closedAgain] = restored?.ledgerId ? await db.execute<{ n: string }>(raw`
    SELECT count(*)::text AS n FROM fiscal_period
     WHERE ledger_id = ${restored.ledgerId}::uuid AND status <> 'open'`) : [{ n: '0' }]
  check(Number(closedAgain.n) === 1,
    'BK5 a month that was closed is closed again, after its entries are back',
    `${closedAgain.n} closed period(s)`)

  // BK6 — the ORIGINAL is untouched. A restore that moved rows rather than
  //       copying them would pass every check above.
  const stillThere = await exportCompany(E)
  check(stillThere.counts.journal_entry === doc.counts.journal_entry
    && stillThere.rows.ledger.length === 1,
    'BK6 the company it came from is exactly as it was',
    `${stillThere.counts.journal_entry} entries still in BKP`)

  // BK7 — THE PARTY IS NOT DUPLICATED. The address book is one list for every
  //       company, and the database refuses two active parties with the same
  //       name — so a restore that inserted a copy would fail outright, and
  //       one that made a differently-named copy would split the supplier.
  const [parties] = await db.execute<{ n: string }>(raw`
    SELECT count(*)::text AS n FROM party WHERE name = ${supplier.name}`)
  const [roles] = restored ? await db.execute<{ n: string }>(raw`
    SELECT count(*)::text AS n FROM party_role
     WHERE party_id = ${supplier.id}::uuid AND entity_id = ${restored.entityId}::uuid`) : [{ n: '0' }]
  check(Number(parties.n) === 1 && Number(roles.n) === 1,
    'BK7 the shared party is matched, not copied, and holds its role in the new company',
    `${parties.n} party row, ${roles.n} role in the restored company`)

  // BK4b — A ROW THAT POINTS AT ITS OWN TABLE, restored in the order that
  //        breaks. Rows go in as they were read, and nothing says a reversal
  //        was read after the entry it reverses — so this restores a document
  //        whose entries and accounts are in the OPPOSITE order and requires
  //        the links to survive. A check that only used the order the export
  //        happened to produce would pass or fail with the weather.
  const backwards = {
    ...read,
    rows: {
      ...read.rows,
      journal_entry: [...read.rows.journal_entry].reverse(),
      account: [...read.rows.account].reverse(),
    },
  }
  let linked = 'not restored'
  try {
    const r = await restoreCompany(backwards, 'alicio@example.test',
      { code: 'BKP5', name: 'Backup Books Ltd. (backwards)' })
    const [pair] = await db.execute<{ n: string }>(raw`
      SELECT count(*)::text AS n FROM journal_entry a
        JOIN journal_entry b ON b.id = a.reverses_id
       WHERE a.ledger_id = ${r.ledgerId}::uuid AND b.ledger_id = ${r.ledgerId}::uuid`)
    const children = await db.execute<{ code: string; parent_code: string }>(raw`
      SELECT c.code,p.code AS parent_code FROM account c
        JOIN account p ON p.id = c.parent_id
       WHERE c.entity_id = ${r.entityId}::uuid AND p.entity_id = ${r.entityId}::uuid`)
    const expectedParents=read.rows.account.filter(a=>a.parent_id).map(a=>({code:a.code,parent_code:read.rows.account.find(p=>p.id===a.parent_id)?.code}))
    linked = `${pair.n} reversal pair, ${children.length} parent links`
    check(Number(pair.n) === 1 && children.length===expectedParents.length && children.every(c=>expectedParents.some(p=>p.code===c.code&&p.parent_code===c.parent_code)),
      'BK4b a row pointing at its own table survives, whatever order the rows are in',
      linked)
  } catch (e) {
    fail('BK4b a row pointing at its own table survives, whatever order the rows are in',
      errorText(e).slice(0, 120))
  }

  // BK4c — and the key that catches a double click does NOT travel. It is
  //        unique across the whole table, so carrying it would refuse the
  //        restore; and if it somehow did not, the copy would be claiming to
  //        be the same submission as the original.
  const [keys] = restored ? await db.execute<{ n: string }>(raw`
    SELECT count(*)::text AS n FROM journal_entry
     WHERE ledger_id = ${restored.ledgerId}::uuid AND idempotency_key IS NOT NULL`) : [{ n: '?' }]
  const [original] = await db.execute<{ n: string }>(raw`
    SELECT count(*)::text AS n FROM journal_entry
     WHERE ledger_id = ${L}::uuid AND idempotency_key = 'the-same-payday-twice'`)
  check(keys.n === '0' && original.n === '1',
    'BK4c the key that catches a double click stays with the original',
    `${keys.n} in the restored company, ${original.n} still on the entry it belongs to`)

  // BK4d — the invoice an entry names is the RESTORED invoice, not the one it
  //        was copied from. Nothing declares `source_id` a foreign key, so
  //        nothing but this would notice it still pointing at another
  //        company's document.
  const [pointsAt] = restored ? await db.execute<{ inside: string; outside: string }>(raw`
    SELECT count(*) FILTER (WHERE i.entity_id = ${restored.entityId}::uuid)::text AS inside,
           count(*) FILTER (WHERE i.entity_id <> ${restored.entityId}::uuid)::text AS outside
      FROM journal_entry e JOIN invoice i ON i.id = e.source_id
     WHERE e.ledger_id = ${restored.ledgerId}::uuid`)
    : [{ inside: '?', outside: '?' }]
  check(Number(pointsAt.inside) > 0 && pointsAt.outside === '0',
    'BK4d a posted invoice’s entry names the restored invoice, not the original',
    `${pointsAt.inside} pointing inside its own company, ${pointsAt.outside} pointing at another`)

  // BK7b — AND MATCHED BY NAME when the id is not here. Restoring into the
  //        database a backup came from finds the party by id and never looks
  //        further; every restore onto a fresh machine takes the other road,
  //        and only this exercises it. The document is doctored rather than
  //        the file, because a doctored FILE is what `BK9` refuses.
  const strangerId = '11111111-2222-3333-4444-555555555555'
  const renamedParty = read.parties.party.find((x) => String(x.id) === supplier.id)!
  const renumbered = structuredClone(read)
  // Change only the business graph for the name-matching fixture. Original
  // audit bytes/scopes remain source provenance and cannot be rewritten.
  renumbered.parties = JSON.parse(JSON.stringify(read.parties).split(supplier.id).join(strangerId))
  renumbered.rows = JSON.parse(JSON.stringify(read.rows).split(supplier.id).join(strangerId))
  let matched: string | null = null
  try {
    const r = await restoreCompany(renumbered, 'alicio@example.test',
      { code: 'BKP4', name: 'Backup Books Ltd. (by name)' })
    // The role belonging to the party whose id was taken away, not whichever
    // role happens to come first: the example company has five parties.
    const [row] = await db.execute<{ party_id: string }>(raw`
      SELECT pr.party_id::text FROM party_role pr JOIN party p ON p.id = pr.party_id
       WHERE pr.entity_id = ${r.entityId}::uuid AND p.name = ${String(renamedParty.name)}
       LIMIT 1`)
    matched = row?.party_id ?? null
  } catch (e) {
    matched = `refused: ${errorText(e).slice(0, 60)}`
  }
  const [stillOne] = await db.execute<{ n: string }>(raw`
    SELECT count(*)::text AS n FROM party WHERE name = ${String(renamedParty.name)}`)
  check(matched === supplier.id && Number(stillOne.n) === 1,
    'BK7b a party whose id is not here is found by name, not copied',
    `${Number(stillOne.n)} party row(s); the role landed on ${matched === supplier.id ? 'the one already here' : matched}`)

  // BK8 — the paper travels. The blob is under the RESTORED company's folder,
  //       which is where that company's own tree looks for it.
  const restoredEntries = restored?.ledgerId ? await db.execute<{ id: string }>(raw`
    SELECT id::text FROM journal_entry
     WHERE ledger_id = ${restored.ledgerId}::uuid
       AND description = 'Stationery, keyed once'`) : []
  const paper = restoredEntries[0] ? await attachmentsOf(restoredEntries[0].id) : []
  // And the minute book's document (0081), bytes of its own: bound to the
  // restored company's record, and readable from the restored company's store.
  const restoredEntity = restored?.entityId ?? null
  const minutePaper = restoredEntity ? await minuteBookPaperOf(restoredEntity) : []
  const minuteBytes = minutePaper[0] && restored?.ledgerId
    ? await minuteBookPaperFile(restored.ledgerId, minutePaper[0].id).catch(() => null) : null
  const [crmPaper] = restored ? await db.execute<{
    sha256: string; original_name: string; account_entity: string
  }>(raw`
    SELECT x.sha256, x.original_name, a.entity_id::text AS account_entity
      FROM crm_attachment x JOIN crm_account a ON a.id = x.account_id
     WHERE x.entity_id = ${restored.entityId}::uuid`) : []
  const crmBytes = crmPaper && restored
    ? await readBlobBytes(restored.name, crmPaper.sha256) : null
  const [signingPaper] = restored ? await db.execute<{sha256:string;operation:string;connection_id:string|null}>(raw`SELECT f.sha256,r.operation,r.connection_id::text FROM esign_file f JOIN esign_request r ON r.document_id=f.document_id WHERE f.entity_id=${restored.entityId}::uuid AND f.kind='source'`) : []
  const signingSourceBytes = signingPaper && restored ? await readBlobBytes(restored.name,signingPaper.sha256) : null
  const [bankPaper] = restored ? await db.execute<{ sha256: string }>(raw`
    SELECT p.sha256 FROM bank_statement_attachment p JOIN bank_statement s ON s.id = p.statement_id
    JOIN account a ON a.id = s.account_id WHERE a.entity_id = ${restored.entityId}::uuid`) : []
  const bankBytes = bankPaper && restored ? await readBlobBytes(restored.name, bankPaper.sha256) : null
  check(paper.length === 1 && read.files.filter(f=>f.storageDomain!=='project').length === 6 && minutePaper.length === 1
        && minuteBytes?.bytes.equals(pdf('the signed resolution itself')) === true
        && crmPaper?.account_entity === restored?.entityId
        && crmPaper.original_name === 'relationship-note.pdf'
        && crmBytes?.equals(pdf('the paper behind it')) === true
        && signingSourceBytes?.equals(pdf('Synthetic signing source')) === true
        && bankBytes?.equals(pdf('the original bank statement')) === true
        && signingPaper.operation === 'DETACHED' && signingPaper.connection_id === null,
    "BK8 receipts, CRM, minute book, statements and signing paper travel with the books",
    `${read.files.length} file(s) in the backup, ${paper.length} on the restored entry, `
      + `${crmPaper ? 'CRM link remapped' : 'CRM link MISSING'}, CRM bytes ${crmBytes ? 'read back' : 'MISSING'}, `
      + `${minutePaper.length} on the restored minute book, whose bytes `
      + `${minuteBytes ? (minuteBytes.bytes.equals(pdf('the signed resolution itself')) ? 'read back' : 'DIFFER') : 'are NOT in the restored store'}`)

  const [restoredAutomation]=restored?await db.execute<{enabled:boolean;mail_enabled:boolean;template_active:boolean;rule_enabled:boolean;job_status:string;inbox_sha:string;mail_sha:string;entry_ledger:string}>(raw`
    SELECT s.enabled,s.mail_enabled,t.active AS template_active,r.enabled AS rule_enabled,j.status AS job_status,
           n.sha256 AS inbox_sha,m.attachment_sha256 AS mail_sha,je.ledger_id::text AS entry_ledger
      FROM automation_setting s JOIN recurring_template t USING(entity_id)
      JOIN reminder_rule r USING(entity_id) JOIN background_job j USING(entity_id)
      JOIN inbox_item n USING(entity_id) JOIN email_message m USING(entity_id)
      JOIN journal_entry je ON je.id=n.target_entry_id WHERE s.entity_id=${restored.entityId}::uuid`):[]
  const sourceBack=restoredAutomation&&restored?await readBlobBytes(restored.name,restoredAutomation.inbox_sha):null
  const mailBack=restoredAutomation&&restored?await readBlobBytes(restored.name,restoredAutomation.mail_sha):null
  const [originalMail]=await db.execute<{sha256:string}>(raw`SELECT attachment_sha256 AS sha256 FROM email_message WHERE id=${approved.id}::uuid`)
  const originalMailBytes=await readBlobBytes('Backup Books Ltd.',originalMail.sha256)
  check(!!restoredAutomation&&!restoredAutomation.enabled&&!restoredAutomation.mail_enabled&&!restoredAutomation.template_active&&!restoredAutomation.rule_enabled
    &&restoredAutomation.job_status==='paused'&&restoredAutomation.entry_ledger===restored?.ledgerId
    &&sourceBack?.equals(inboxBytes)===true&&!!mailBack&&!!originalMailBytes&&mailBack.equals(originalMailBytes),
    'BK8a restored automation is paused, original target remapped and both private PDFs byte-identical')

  // BK11 — THE OTHER HALF OF LOADING WITH THE GUARDS OFF. A restore turns
  //        the foreign keys off so the order of the tables stops mattering,
  //        and checks every reference afterwards INSIDE the same transaction.
  //        A file that does not hold everything it points at must therefore
  //        be refused whole, not restored with holes in it.
  const holed = {
    ...read,
    rows: { ...read.rows, bank_transaction: read.rows.bank_transaction.slice(1) },
  }
  let holedSaid = 'it was restored'
  try {
    await restoreCompany(holed, ACTOR, { code: 'BKP6', name: 'Backup Books Ltd. (holed)' })
  } catch (e) {
    if (e instanceof BackupError) holedSaid = e.code
    else {
      const chain: string[] = []
      for (let cur: unknown = e, i = 0; cur && i < 5; i++) {
        const err = cur as { message?: string; constraint_name?: string; cause?: unknown }
        if (err.constraint_name) chain.push(err.constraint_name)
        else if (err.message) chain.push(err.message.split('\n')[0])
        cur = err.cause
      }
      holedSaid = `threw ${chain.join(' | ').slice(0, 120)}`
    }
  }
  const [landed] = await db.execute<{ n: string }>(raw`
    SELECT count(*)::text AS n FROM entity WHERE code = 'BKP6'`)
  check(holedSaid === 'INCOMPLETE' && landed.n === '0',
    'BK11 a file that does not hold everything it points at is refused whole',
    `${holedSaid}; ${landed.n} company left behind`)

  check(!!restored && projectProfit((await projectSummaries(restored.entityId,{},restored.projectMap[projectId]))[0]).before===10000n
      && (await readProjectBlob(restored.entityId,restored.projectMap[projectId],projectSha))?.equals(projectBytes)===true,
    'BK8p Project rows, profit and UUID-scoped independent bytes survive a full company restore')

  // BK11b — 0087's company boundary foreign keys are composite. The load has
  //          triggers off, so testing only one-column constraints would let a
  //          CRM relation name a row from a company already in this database.
  //          The checker must understand the whole FK column group.
  {
    const [outside] = restored ? await db.execute<{ id: string }>(raw`
      SELECT id::text FROM crm_account
       WHERE entity_id = ${restored.entityId}::uuid LIMIT 1`) : []
    const crossed = {
      ...read,
      rows: {
        ...read.rows,
        crm_attachment: read.rows.crm_attachment.map((row, i) => i === 0
          ? { ...row, account_id: outside?.id ?? row.account_id }
          : row),
      },
    }
    let said = 'it was restored'
    try {
      await restoreCompany(crossed, ACTOR, {
        code: 'BKP8', name: 'Backup Books Ltd. (crossed CRM)',
      })
    } catch (e) {
      said = e instanceof BackupError ? e.code : errorText(e).slice(0, 80)
    }
    const [crossedLanded] = await db.execute<{ n: string }>(raw`
      SELECT count(*)::text AS n FROM entity WHERE code = 'BKP8'`)
    check(!!outside && said === 'INCOMPLETE' && crossedLanded.n === '0',
      'BK11b a composite CRM company reference is checked and refused whole',
      `${said}; ${crossedLanded.n} company left behind`)
  }

  // BK11c — A ROW'S KEYS ARE THE FILE'S TO CHOOSE. They became the column list
  //          of an INSERT run with the triggers off, and the checksum is a plain
  //          SHA-256 anybody can recompute — so a key carrying a quote and a
  //          statement was SQL somebody else wrote (security review,
  //          2026-10-20). Asked of `restoreCompany` directly: a recomputed
  //          checksum is what an attacker would hand `readFigtree` anyway.
  {
    const evil = 'name") VALUES (\'x\'); CREATE TABLE bk_injected (x int); --'
    const injected = {
      ...read,
      rows: { ...read.rows, account: read.rows.account.map((row, i) => i === 0 ? { ...row, [evil]: 'x' } : row) },
    }
    let said = 'it was restored'
    try {
      await restoreCompany(injected, ACTOR, { code: 'BKP10', name: 'Backup Books Ltd. (injected)' })
    } catch (e) {
      said = e instanceof BackupError ? e.code : errorText(e).slice(0, 80)
    }
    const [after] = await db.execute<{ table: string | null; n: string }>(raw`
      SELECT to_regclass('bk_injected')::text AS table,
             (SELECT count(*)::text FROM entity WHERE code = 'BKP10') AS n`)
    check(said === 'UNKNOWN_COLUMN' && after.table === null && after.n === '0',
      'BK11c a column the database does not have is refused before anything is written',
      `${said}; injected table ${after.table ?? 'absent'}; ${after.n} company left behind`)
  }

  // BK11d — AND THE BOOKS THEMSELVES. The load has every trigger off, so an
  //          entry out of balance or a balance cache that disagrees with its
  //          lines went in as the file said. Both must roll the restore back.
  {
    const posted = new Set(read.rows.journal_entry.filter((e) => e.status === 'posted').map((e) => e.id))
    const target = read.rows.journal_line.findIndex((l) => posted.has(l.entry_id))
    const nudged = (row: Record<string, unknown>, col: string) =>
      ({ ...row, [col]: String(BigInt(String(row[col])) + 100n) })
    const variants: Array<[string, string, typeof read]> = [
      ['an entry out of balance', 'BKP11', { ...read, rows: { ...read.rows,
        journal_line: read.rows.journal_line.map((l, i) => i === target ? nudged(l, 'amount') : l) } }],
      ['a balance cache that disagrees with its lines', 'BKP12', { ...read, rows: { ...read.rows,
        period_balance: read.rows.period_balance.map((b, i) => i === 0 ? nudged(b, 'closing_balance') : b) } }],
    ]
    const results: string[] = []
    for (const [what, code, file] of variants) {
      let said = 'it was restored'
      try {
        await restoreCompany(file, ACTOR, { code, name: `Backup Books Ltd. (${code})` })
      } catch (e) {
        said = e instanceof BackupError ? e.code : errorText(e).slice(0, 80)
      }
      const [n] = await db.execute<{ n: string }>(raw`SELECT count(*)::text AS n FROM entity WHERE code = ${code}`)
      results.push(`${what}: ${said}, ${n.n} left behind`)
    }
    check(target >= 0 && read.rows.period_balance.length > 0
          && results.every((r) => r.endsWith('NOT_BALANCED, 0 left behind')),
      'BK11d books that do not hold together are refused whole',
      results.join('; '))
  }

  // BK12 — the load still creates ONE new arrival event; imported history is
  //        separate and keeps its old actions. The trigger is off during the
  //        load, so every attribution field on this event must be explicit.
  const [trail] = restored ? await db.execute<{
    n: string; scope: string; entity_id: string | null; ledger_id: string | null; reason: string | null
  }>(raw`
    SELECT count(*)::text AS n, max(scope) AS scope, max(entity_id::text) AS entity_id,
           max(ledger_id::text) AS ledger_id, max(reason) AS reason
      FROM audit_log
     WHERE record_id = ${restored.entityId} AND action = 'restore'`) : [{
       n: '?', scope: '?', entity_id: null, ledger_id: null, reason: null,
     }]
  check(trail.n === '1' && trail.scope === 'company' && trail.entity_id === restored?.entityId
      && trail.ledger_id === restored?.ledgerId && trail.reason === 'Restored from a portable .fig backup',
    'BK12 a restore adds one fully-attributed arrival event beside the imported history',
    `${trail.n} row(s), ${trail.scope}, ${trail.reason}`)

  // BK9 — every refusal in words, because a person chose this file.
  const refusals: Array<[string, () => unknown, string]> = [
    ['something that is not a backup at all', () => readFigtree(Buffer.from('hello')), 'NOT_A_FIGTREE'],
    ['a backup somebody edited', async () => {
      const tampered = { ...read, entity: { ...read.entity, name: 'Someone Else Ltd.' } }
      return readFigtree(await packFigtree(tampered))
    }, 'CHANGED'],
    ['a code already in use', async () => restoreCompany(read, 'alicio@example.test', { code: 'BKP' }), 'CODE_TAKEN'],
    // Kept its own name beside the original: one folder of papers for two
    // companies, which a rename or a rebuild of either would take from the other.
    ['the name of a company already here', async () => restoreCompany(read, 'alicio@example.test', { code: 'BKP9' }), 'NAME_TAKEN'],
    ['a backup from a newer FigTree', async () => restoreCompany(
      { ...read, schema: { count: read.schema.count + 5, last: 'later' } },
      'alicio@example.test', { code: 'BKP3' }), 'TOO_NEW'],
  ]
  const wrong: string[] = []
  for (const [what, run, code] of refusals) {
    try { await run(); wrong.push(`${what}: ACCEPTED`) }
    catch (e) {
      if (!(e instanceof BackupError) || e.code !== code) wrong.push(`${what}: ${errorText(e).slice(0, 50)}`)
    }
  }
  check(wrong.length === 0,
    'BK9 every wrong file is refused by name',
    wrong.length === 0 ? refusals.map(([w]) => w).join('; ') : wrong.join(' | '))

  // BK10 — and the screen can say what it is about to do before doing it.
  const seen = await inspectFigtree(read)
  check(seen.company.code === 'BKP' && seen.codeTaken && !seen.tooNew && seen.entries === doc.counts.journal_entry,
    'BK10 a file can be looked at before it is restored',
    `${seen.company.name}: ${seen.entries} entries, ${seen.parties} parties, code taken ${seen.codeTaken}`)

  // BK10b — the format bump does not strand files already on disk. This is a
  // real pre-0087 shape: no audit section and no CRM tables at all, not merely
  // a current export with its version label changed. Restore must establish
  // the current schema's default pipeline explicitly because load mode turns
  // off the ordinary entity-insert trigger.
  {
    const legacyRows = Object.fromEntries(Object.entries(read.rows)
      .filter(([table]) => !table.startsWith('crm_')&&!table.startsWith('project')))
    const legacyCounts = Object.fromEntries(Object.entries(read.counts)
      .filter(([table]) => !table.startsWith('crm_')&&!table.startsWith('project')))
    const legacy = {
      ...read, figtree: 1, rows: legacyRows, counts: legacyCounts,
      files:read.files.filter(f=>f.storageDomain!=='project').map(({sha256,bytes,mime,size})=>({sha256,bytes,mime,size})),
      schema: { count: 85, last: '0085_the_trail_strips_only_its_own_register.sql' },
    }
    delete legacy.audit
    delete legacy.auditProof
    const unsigned = { ...legacy } as Record<string, unknown>
    delete unsigned.checksum
    const ordered: Record<string, unknown> = {}
    for (const key of Object.keys(unsigned).sort()) ordered[key] = unsigned[key]
    legacy.checksum = createHash('sha256').update(JSON.stringify(ordered)).digest('hex')
    const old = readFigtree(gzipSync(Buffer.from(JSON.stringify(legacy), 'utf8')))
    const oldSeen = await inspectFigtree(old)
    let oldMade: Awaited<ReturnType<typeof restoreCompany>> | null = null
    try {
      oldMade = await restoreCompany(old, ACTOR, {
        code: 'BKP7', name: 'Backup Books Ltd. (legacy v1)',
      })
    } catch { /* the assertion below names the failed restore */ }
    const [oldTrail] = oldMade ? await db.execute<{ n: string; restores: string }>(raw`
      SELECT count(*)::text AS n,
             count(*) FILTER (WHERE action = 'restore')::text AS restores
        FROM audit_log WHERE entity_id = ${oldMade.entityId}::uuid`) : [{ n: '0', restores: '0' }]
    const [oldCrm] = oldMade ? await db.execute<{ pipelines: string; stages: string }>(raw`
      SELECT count(DISTINCT p.id)::text AS pipelines, count(s.id)::text AS stages
        FROM crm_pipeline p JOIN crm_stage s ON s.pipeline_id = p.id
       WHERE p.entity_id = ${oldMade.entityId}::uuid AND p.is_default`) : [{
         pipelines: '0', stages: '0',
       }]
    check(old.figtree === 1 && !oldSeen.auditIncluded && oldSeen.audit === 0
        && !!oldMade && oldTrail.n === '1' && oldTrail.restores === '1'
        && oldCrm.pipelines === '1' && oldCrm.stages === '6',
      'BK10b a real pre-CRM v1 file restores without historical audit and gains a usable pipeline',
      `${oldMade ? 'restored' : 'refused'}; audit included ${oldSeen.auditIncluded}; `
        + `${oldTrail.n} new event(s); ${oldCrm.pipelines} pipeline / ${oldCrm.stages} stages`)
  }

  // BK19 — WHAT THE SCREEN CALLS A BACKUP, AND WHAT IT WILL OPEN.
  //
  //       The extension went from `.figtree` to `.fig` (owner, 2026-09-12). The
  //       half of that which can quietly go wrong is the FILE PICKER: an
  //       `accept` listing only the new name hides every backup already on
  //       disk, and the screen looks entirely correct while doing it. That is
  //       on record from the bill reader, which said it took PDFs in its code,
  //       its help text, its doc and its changelog while its own `accept`
  //       filtered them out.
  //
  //       So this reads the rendered control back rather than the sentence
  //       beside it, and it asserts BOTH names — the new one because that is
  //       what is written now, the old one because a rename must not take
  //       somebody's own files away from them.
  {
    const html = (JSON.parse(execFileSync('npx', [
      'tsx', 'scripts/render-backup-screen.tsx',
    ], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } })) as { html: string }).html
    const accept = /accept="([^"]*)"/.exec(html)?.[1] ?? '(no accept at all)'
    const offered = accept.split(',').map((e) => e.trim())
    const saves = /Save ([A-Z]+\.[a-z]+)</.exec(html)?.[1] ?? '(no save button)'
    const ownerRestore = html.includes('Restore as a new company')
      && html.includes('company-scoped audit history')
      && !html.includes('npm run restore:company')
    check(BACKUP_EXT === '.fig' && offered.includes('.fig') && offered.includes('.figtree')
      && saves.endsWith(BACKUP_EXT) && ownerRestore,
      'BK19 a backup is saved as .fig, old files remain visible, and the owner gets web restore',
      `the button offers ${saves}; the picker accepts ${accept}`
        + `${offered.includes('.figtree') ? '' : ' — THE OLD NAME IS GONE'}; owner restore ${ownerRestore}`)
  }

  // BK20 — THE RESTORE CHECK'S FINGERPRINT NAMES EVERY TABLE. `backup:check`
  //       compared eleven figures over eight tables — the ledger kernel — so
  //       payroll, SR&ED, the attachments and the registers could come back
  //       empty and it would say the backup was good. The fingerprint is now
  //       built from the catalogue; this runs it against the test database and
  //       asks that every table is in it, that the tables the old one forgot
  //       are named, and that one changed count reads back as a difference.
  {
    const { TABLES_SQL, fingerprintSql, parseFingerprint, fingerprintDifferences } =
      await import('../src/lib/backup-fingerprint')
    const tables = (await db.execute<{ tablename: string }>(raw.raw(TABLES_SQL))).map((t) => t.tablename)
    const rows = await db.execute<{ name: string; value: string }>(raw.raw(fingerprintSql(tables)))
    const got = new Map(rows.map((row) => [row.name, row.value]))
    const forgotten = tables.filter((t) => !got.has(t))
    const asked = ['pay_stub', 'payroll_employee', 'sred_claim', 'sred_time', 'attachment_blob',
                   'attachment_blob.bytes', 'share_transaction', 'minute_book_entry', 'journal_line.amount']
    const notAsked = asked.filter((n) => !got.has(n))
    const parsed = parseFingerprint(rows.map((row) => `${row.name}|${row.value}`).join('\n'))
    const changed = new Map(got)
    changed.set('pay_stub', String(Number(got.get('pay_stub')) + 1))
    const diff = fingerprintDifferences(got, changed)
    check(tables.length > 40 && forgotten.length === 0 && notAsked.length === 0 && parsed.size === got.size
      && diff.length === 1 && (diff[0] ?? '').startsWith('pay_stub: books'),
      'BK20 the restore check fingerprints every table in the database, and the money',
      `${got.size} figures over ${tables.length} tables${forgotten.length ? ` — FORGOTTEN: ${forgotten.join(', ')}` : ''}`
        + `${notAsked.length ? `; not asked: ${notAsked.join(', ')}` : '; payroll, SR&ED, attachments and registers all asked'}`
        + `; one changed count reads back as "${diff[0] ?? 'nothing'}"`)
  }

  // BK21 — THE PATHS ARE NOT THIS MAC'S. Four files spelled out Homebrew's
  //       Apple-Silicon directory and one default under ~/Library. One
  //       resolver now: told (PG_BIN, BACKUP_DIR), then found, then PATH; and
  //       the backup directory follows the platform.
  {
    const { PG_BIN_CANDIDATES, backupDir, pgBin, pgTool } = await import('../src/lib/backup-paths')
    const told = pgTool('pg_dump', { PG_BIN: '/somewhere/else/bin' })
    const found = pgBin({})
    const mac = backupDir({}, 'darwin')
    const xdg = backupDir({ XDG_DATA_HOME: '/data' }, 'linux')
    const linux = backupDir({}, 'linux')
    const chosen = backupDir({ BACKUP_DIR: '/mnt/x' }, 'linux')
    check(told === '/somewhere/else/bin/pg_dump' && (found === '' || PG_BIN_CANDIDATES.includes(found))
      && mac.endsWith('/Library/Application Support/erp-backup') && xdg === '/data/erp-backup'
      && linux.endsWith('/.local/share/erp-backup') && chosen === '/mnt/x',
      'BK21 the PostgreSQL tools and the backup directory are resolved, not spelled out',
      `PG_BIN told: ${told}; found here: ${found || '(PATH)'}; dir on a Mac …${mac.slice(-40)}, `
        + `on Linux ${xdg} / …${linux.slice(-26)}, told ${chosen}`)
  }

  // BK22 — THE SCRIPT ITSELF, END TO END, against the test database: told
  // Earlier cases intentionally restored rows without optional paper. Supply
  // their known synthetic Project bytes before expecting a complete SYSTEM set.
  for(const b of await db.execute<{entity_id:string;project_id:string;sha256:string}>(raw`SELECT entity_id::text,project_id::text,sha256 FROM project_attachment_blob`)) {
    if(b.sha256===projectSha)await writeProjectBlob(b.entity_id,b.project_id,b.sha256,projectBytes)
  }
  //        of a store it cannot see, it must say so (that is the branch the
  //        installed copy never reached, because nothing told it where the
  //        store was and it looked beside itself); told of one it can see,
  //        it archives it. The config file is what the installer writes.
  {
    const { copyFileSync, mkdirSync, readFileSync, writeFileSync } = await import('node:fs')
    const dir = mkdtempSync(path.join(os.tmpdir(), 'erp-backup-run-'))
    mkdirSync(path.join(dir, 'backups'))
    copyFileSync('ops/write-status.py', path.join(dir, 'write-status.py'))
    const env: NodeJS.ProcessEnv = { ...process.env, BACKUP_DIR: dir, NODE_OPTIONS: '' }
    delete env.ATTACHMENTS_DIR
    const run = (attachments?: string, projectStore = true) => {
      const runEnv: NodeJS.ProcessEnv = attachments ? { ...env, ATTACHMENTS_DIR: attachments } : { ...env }
      if (!projectStore) delete runEnv.PROJECT_ATTACHMENTS_DIR
      let out = ''
      try {
        execFileSync('bash', ['scripts/backup.sh', '--quiet'],
          { encoding: 'utf8', env: runEnv, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (e) { out = (e as { stderr?: string }).stderr?.toString().slice(0, 200) ?? String(e) }
    const rec = JSON.parse(readFileSync(path.join(dir, 'last-backup.json'), 'utf8')) as {
      ok: boolean; complete?: boolean; attachments?: string; error?: string; problems?: string[]
    }
      return { ...rec, stderr: out }
    }
    // Told by the config file (the installer's way), pointing nowhere.
    writeFileSync(path.join(dir, 'config'), `DATABASE_URL=${process.env.DATABASE_URL}\nATTACHMENTS_DIR=/nowhere/config/attachments\n`)
    const unseen = run()
    // Told by the environment, pointing at a store with a file in it.
    const store = process.env.ATTACHMENTS_DIR!
    const seen = run(store)
    check(unseen.ok === true && unseen.complete === false
      && (unseen.attachments ?? '').startsWith('ATTACHMENTS NOT BACKED UP')
      && (unseen.problems ?? []).some((p) => p.includes('attachment store was not archived'))
      && seen.ok === true && seen.complete === true
      && (seen.attachments ?? '').startsWith('attachments archived'),
      'BK22 backup.sh says when it cannot see the store it was told of, and archives one it can',
      `told by config of a store that is not there: ok=${unseen.ok}, "${(unseen.attachments ?? unseen.error ?? unseen.stderr).slice(0, 70)}…"; `
        + `told by the environment of a real one: ok=${seen.ok}, "${(seen.attachments ?? seen.error ?? seen.stderr).slice(0, 40)}"`)
    const noProject = run(store, false)
    check(noProject.ok === true && noProject.complete === false
      && (noProject.problems ?? []).some(p => p.includes('Project')),
      'BK22a backup without optional Project storage writes a dump and reports missing paper',
      `ok=${noProject.ok}, complete=${noProject.complete}; no empty argument array crash`)
  }

  console.log(r.summary())
  await conn.end()
  process.exit(r.failures === 0 ? 0 : 1)
}

main().catch(async (e) => { console.error(e); await conn.end(); process.exit(1) })
