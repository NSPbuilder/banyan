import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { attachmentsDir } from './backup-paths'
import { actingAs, type Runner } from './acting'
import { auditRow } from './audit-row'
import { openProject, ProjectError, projectId, projectCompany } from './project'
import { AttachmentError, attachmentsOf, attachmentFile, saveAttachment, deleteAttachment } from './attachments'
import { DocumentError } from './customer-docs'
import { RECEIPT_SUPPORTING_MAX_BYTES, validateReceiptSupporting, type ReceiptSupportingFile } from './receipt-supporting-pdf'

// The root is configured at runtime. Avoid tracing the whole checkout as
// potential attachment bytes; node:fs/promises is a built-in in every runtime.
const runtimeFS=import(/* webpackIgnore: true */ /* turbopackIgnore: true */ 'node:fs/promises')
const runtimePath=import(/* webpackIgnore: true */ /* turbopackIgnore: true */ 'node:path').then(m=>m.default)

async function canonical(p:string):Promise<string> {
  const fs=await runtimeFS
  const path=await runtimePath
  try { return await fs.realpath(p) } catch(error) {
    if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error
    const parent=path.dirname(p)
    if(parent===p) throw error
    return path.join(await canonical(parent),path.basename(p))
  }
}
export async function projectStorageRoot():Promise<string> {
  const path=await runtimePath
  const configured=process.env.PROJECT_ATTACHMENTS_DIR?.trim()
  if(!configured || !path.isAbsolute(configured)) throw new ProjectError('STORAGE','Project file storage needs its own absolute PROJECT_ATTACHMENTS_DIR. Ask the administrator to configure it.')
  const root=await canonical(configured), original=await canonical(path.resolve(attachmentsDir()))
  const normalize=(p:string)=>process.platform==='darwin'?p.toLowerCase():p
  const a=normalize(root), b=normalize(original)
  if(a===b || a.startsWith(b+path.sep) || b.startsWith(a+path.sep)) throw new ProjectError('STORAGE','Project storage must be separate from the existing attachments folder, with neither folder inside the other.')
  return root
}
async function blobPath(entityId:string,project:string,sha:string) {
  const path=await runtimePath
  projectId(entityId); projectId(project)
  if(!/^[a-f0-9]{64}$/.test(sha)) throw new ProjectError('FILE','That file hash is invalid.')
  const root=await projectStorageRoot()
  const directory=await canonical(path.join(root,entityId,project,'blobs'))
  if(directory!==path.join(root,entityId,project,'blobs')) throw new ProjectError('STORAGE','A Project file path leaves its own project folder.')
  return path.join(directory,sha)
}
export async function writeProjectBlob(entityId:string,project:string,sha:string,bytes:Buffer) {
  const fs=await runtimeFS
  const path=await runtimePath
  if(createHash('sha256').update(bytes).digest('hex')!==sha) throw new ProjectError('FILE','The file bytes do not match their hash.')
  const file=await blobPath(entityId,project,sha)
  await fs.mkdir(path.dirname(file),{recursive:true})
  try {
    await checkBlobFile(file)
    const old=await fs.readFile(file)
    if(!old.equals(bytes)) throw new ProjectError('FILE','An existing file is damaged. It was not overwritten.')
    return
  } catch(error) { if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error }
  const temporary=file+'.tmp-'+randomUUID()
  try { await fs.writeFile(temporary,bytes,{flag:'wx'}); await fs.rename(temporary,file) }
  finally { await fs.unlink(temporary).catch(()=>{}) }
}
export async function readProjectBlob(entityId:string,project:string,sha:string):Promise<Buffer|null> {
  const fs=await runtimeFS
  try {
    const file=await blobPath(entityId,project,sha)
    await checkBlobFile(file)
    const bytes=await fs.readFile(file)
    if(createHash('sha256').update(bytes).digest('hex')!==sha) throw new ProjectError('FILE','This Project file is damaged. Restore it from a verified backup.')
    return bytes
  } catch(error) {if((error as NodeJS.ErrnoException).code==='ENOENT') return null; throw error}
}
async function checkBlobFile(file:string) {
  const fs=await runtimeFS
  const stat=await fs.lstat(file)
  if(!stat.isFile()||stat.nlink!==1) throw new ProjectError('STORAGE','Project files must be regular files, with no symbolic or hard links.')
}
export type ProjectAttachment = {id:string;project_id:string;record_id:string|null;payment_id:string|null;sha256:string;uploaded_filename:string;mime:string;byte_size:string;note:string|null}
export async function projectAttachments(entityId:string,project?:string):Promise<ProjectAttachment[]> {
  const rows=await db.execute<ProjectAttachment>(sql`SELECT a.*,a.id::text,a.project_id::text,a.record_id::text,a.payment_id::text,b.mime,b.byte_size::text
    FROM project_attachment a JOIN project_attachment_blob b USING(entity_id,project_id,sha256)
    WHERE a.entity_id=${projectId(entityId)}::uuid ${project?sql`AND a.project_id=${projectId(project)}::uuid`:sql``} ORDER BY a.created_at DESC`)
  return Array.from(rows)
}

/** Project access grants access only to the supporting of this mapped payment. */
export async function projectPaymentAttachmentTarget(entityId:string,project:string,payment:string,on:Runner=db) {
  projectId(entityId);projectId(project);projectId(payment)
  const [row]=await on.execute<{entry_id:string|null;ledger_id:string|null;linked:boolean}>(sql`
    SELECT h.entry_id::text,j.ledger_id::text,h.payment_id IS NOT NULL AS linked
    FROM project_payment pay JOIN project p ON p.id=pay.project_id
    LEFT JOIN project_accounting_payment h ON h.payment_id=pay.id
    LEFT JOIN journal_entry j ON j.id=h.entry_id
    LEFT JOIN ledger l ON l.id=j.ledger_id AND l.entity_id=p.entity_id
    WHERE pay.id=${payment}::uuid AND pay.project_id=${project}::uuid
      AND pay.entity_id=${entityId}::uuid AND p.entity_id=${entityId}::uuid
      AND p.deleted_at IS NULL AND pay.state='active'
      AND (h.payment_id IS NULL OR (h.entity_id=p.entity_id AND (h.entry_id IS NULL OR l.id IS NOT NULL)))`)
  if(!row)throw new ProjectError('NO_PROJECT','That payment is not in this project.')
  if(row.linked&&(!row.entry_id||!row.ledger_id))throw new ProjectError('FILE','The original accounting payment is no longer available.')
  return row
}

export type ProjectPaymentAttachment={id:string;source:'accounting'|'project';filename:string;mime:string;byte_size:string;sha256:string}
export async function projectPaymentAttachments(entityId:string,project:string,payment:string):Promise<ProjectPaymentAttachment[]> {
  const target=await projectPaymentAttachmentTarget(entityId,project,payment)
  const [shared,local]=await Promise.all([target.entry_id?attachmentsOf(target.entry_id):Promise.resolve([]),projectAttachments(entityId,project)])
  return [
    ...shared.map(a=>({id:a.id,source:'accounting' as const,filename:a.uploaded,mime:a.mime,byte_size:a.byte_size,sha256:a.sha256})),
    ...local.filter(a=>a.payment_id===payment.toLowerCase()).map(a=>({id:a.id,source:'project' as const,filename:a.uploaded_filename,mime:a.mime,byte_size:a.byte_size,sha256:a.sha256})),
  ]
}

export async function readProjectPaymentAttachment(entityId:string,project:string,payment:string,id:string) {
  projectId(id)
  const target=await projectPaymentAttachmentTarget(entityId,project,payment)
  const file=(await projectPaymentAttachments(entityId,project,payment)).find(a=>a.id===id.toLowerCase())
  if(!file)return null
  let bytes:Buffer|null|undefined
  try{bytes=file.source==='accounting'?(await attachmentFile(target.ledger_id!,id))?.bytes:await readProjectBlob(entityId.toLowerCase(),project.toLowerCase(),file.sha256)}
  catch(error){if(error instanceof ProjectError)throw error;throw new ProjectError('FILE',`The supporting file "${file.filename}" could not be read. Restore or replace it before exporting the Receipt.`)}
  if(!bytes)throw new ProjectError('FILE',`The supporting file "${file.filename}" is missing. Restore or replace it before exporting the Receipt.`)
  if(createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw new ProjectError('FILE',`The supporting file "${file.filename}" is damaged. Restore or replace it before exporting the Receipt.`)
  return {...file,bytes}
}

export async function attachProjectFile(input:{entityId:string;projectId:string;recordId?:string;paymentId?:string;filename:string;mime:string;bytes:Buffer;note?:string;actor:string}) {
  const path=await runtimePath
  if(!input.bytes.length || input.bytes.length>20*1024*1024) throw new ProjectError('FILE','Choose a non-empty file up to 20 MB.')
  if(input.recordId&&input.paymentId) throw new ProjectError('FILE','Attach the file to one record or payment.')
  if(input.paymentId) {
    for(const id of [input.entityId,input.projectId,input.paymentId])projectId(id)
    input={...input,entityId:input.entityId.toLowerCase(),projectId:input.projectId.toLowerCase(),paymentId:input.paymentId.toLowerCase()}
  }
  const filename=path.basename(input.filename.replaceAll('\\','/')).replace(/[\r\n\0]/g,'').slice(0,240)||'document'
  const allowed=new Set(['application/pdf','image/jpeg','image/png','image/webp','image/heic','image/heif','text/plain','text/csv','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])
  const mime=allowed.has(input.mime)?input.mime:'application/octet-stream'
  const sha=createHash('sha256').update(input.bytes).digest('hex')
  return actingAs(input.actor,async tx=>{
    await openProject(tx,input.entityId,input.projectId)
    for(const [table,id] of [['project_record',input.recordId],['project_payment',input.paymentId]] as const) {
      if(!id) continue
      const [row]=await tx.execute(sql`SELECT id FROM ${sql.raw(table)} WHERE id=${projectId(id)}::uuid AND entity_id=${input.entityId}::uuid AND project_id=${input.projectId}::uuid`)
      if(!row) throw new ProjectError('FILE','That attachment target is not in this project.')
    }
    if(input.paymentId) {
      const target=await projectPaymentAttachmentTarget(input.entityId,input.projectId,input.paymentId,tx)
      try{await validateReceiptSupporting({filename,mime,bytes:input.bytes})}
      catch(error){if(error instanceof DocumentError)throw new ProjectError('FILE',error.message);throw error}
      if(target.entry_id) {
        // Keep the Project lock while filing, so a payment correction cannot
        // switch its entry between target resolution and saveAttachment.
        try{return (await saveAttachment({ledgerId:target.ledger_id!,entryId:target.entry_id,filename,mime,bytes:input.bytes,note:input.note,actor:input.actor},tx)).id}
        catch(error){if(error instanceof AttachmentError)throw new ProjectError('FILE',error.message);throw error}
      }
    }
    // Bytes are immutable; a failed DB transaction can leave an unreferenced
    // blob, never a metadata row claiming that missing bytes were archived.
    await writeProjectBlob(input.entityId,input.projectId,sha,input.bytes)
    await tx.execute(sql`INSERT INTO project_attachment_blob(entity_id,project_id,sha256,byte_size,mime)
      VALUES(${input.entityId}::uuid,${input.projectId}::uuid,${sha},${input.bytes.length},${mime}) ON CONFLICT DO NOTHING`)
    const [a]=await tx.execute<{id:string}>(sql`INSERT INTO project_attachment(entity_id,project_id,record_id,payment_id,sha256,uploaded_filename,note,created_by)
      VALUES(${input.entityId}::uuid,${input.projectId}::uuid,${input.recordId||null}::uuid,${input.paymentId||null}::uuid,${sha},${filename},${input.note?.trim()||null},${input.actor}) RETURNING id::text`)
    await auditRow(tx,{actor:input.actor,action:'attach_project_file',table:'project_attachment',recordId:a.id,entityId:input.entityId,scope:'company',after:{projectId:input.projectId,sha256:sha,filename}})
    return a.id
  })
}
export async function detachProjectFile(entityId:string,project:string,id:string,actor:string) {
  return actingAs(actor,async tx=>{
    await openProject(tx,entityId,project)
    const rows=await tx.execute(sql`DELETE FROM project_attachment WHERE id=${projectId(id)}::uuid AND entity_id=${entityId}::uuid AND project_id=${project}::uuid RETURNING *`)
    if(!rows.length) throw new ProjectError('FILE','That attachment is not in this project.')
    await auditRow(tx,{actor,action:'detach_project_file',table:'project_attachment',recordId:id,entityId,scope:'company',before:rows[0]})
  })
}

/** Remove only proof belonging to this active payment, using its current mapping. */
export async function detachProjectPaymentFile(entityId:string,project:string,payment:string,id:string,actor:string) {
  for(const value of [entityId,project,payment,id])projectId(value)
  ;[entityId,project,payment,id]=[entityId,project,payment,id].map(value=>value.toLowerCase())
  return actingAs(actor,async tx=>{
    await openProject(tx,entityId,project)
    const target=await projectPaymentAttachmentTarget(entityId,project,payment,tx)
    const [native]=await tx.execute(sql`DELETE FROM project_attachment
      WHERE id=${id}::uuid AND entity_id=${entityId}::uuid AND project_id=${project}::uuid AND payment_id=${payment}::uuid RETURNING *`)
    if(native) {
      await auditRow(tx,{actor,action:'detach_project_file',table:'project_attachment',recordId:id,entityId,scope:'company',before:native,context:{projectId:project,paymentId:payment}})
      return
    }
    if(target.entry_id) {
      const [shared]=await tx.execute(sql`SELECT id FROM attachment WHERE id=${id}::uuid AND entry_id=${target.entry_id}::uuid FOR UPDATE`)
      if(shared) {
        try{await deleteAttachment(target.ledger_id!,id,actor,'Removed from Project payment attachments.',tx);return}
        catch(error){if(error instanceof AttachmentError)throw new ProjectError('FILE',error.message);throw error}
      }
    }
    throw new ProjectError('FILE','That attachment is not on this payment.')
  })
}

export async function projectReceiptAttachments(ledgerId:string,projectIdValue:string,paymentId:string):Promise<ReceiptSupportingFile[]> {
  try {
    const company=await projectCompany(ledgerId),target=await projectPaymentAttachmentTarget(company.id,projectIdValue,paymentId)
    if(target.ledger_id&&target.ledger_id!==ledgerId.toLowerCase())throw new DocumentError('NO_RECEIPT','Open this payment in its original accounting book.')
    const files=await projectPaymentAttachments(company.id,projectIdValue,paymentId);if(files.reduce((n,f)=>n+BigInt(f.byte_size),0n)>BigInt(RECEIPT_SUPPORTING_MAX_BYTES))throw new DocumentError('RECEIPT_SUPPORTING','The Receipt supporting exceeds 100 MB. Split or compress its files before exporting.')
    const result:ReceiptSupportingFile[]=[]
    for(const file of files) {
      const content=await readProjectPaymentAttachment(company.id,projectIdValue,paymentId,file.id)
      if(!content)throw new DocumentError('RECEIPT_SUPPORTING',`The supporting file "${file.filename}" is no longer available. Reload before exporting.`)
      result.push({filename:file.filename,mime:file.mime,bytes:content.bytes})
    }
    return result
  } catch(error) {if(error instanceof ProjectError)throw new DocumentError('RECEIPT_SUPPORTING',error.message);throw error}
}
