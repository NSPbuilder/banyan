import 'server-only'
import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { attachmentFile, attachmentsOf } from './attachments'
import { DocumentError } from './customer-docs'
import { RECEIPT_SUPPORTING_MAX_BYTES, type ReceiptSupportingFile } from './receipt-supporting-pdf'

function sizeLimit(files:Array<{byte_size:string}>) {
  if(files.reduce((n,f)=>n+BigInt(f.byte_size),0n)>BigInt(RECEIPT_SUPPORTING_MAX_BYTES))
    throw new DocumentError('RECEIPT_SUPPORTING','The Receipt supporting exceeds 100 MB. Split or compress its files before exporting.')
}

export async function entryReceiptAttachments(ledgerId:string,entryId:string):Promise<ReceiptSupportingFile[]> {
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if(!uuid.test(ledgerId)||!uuid.test(entryId))throw new DocumentError('NO_RECEIPT','That payment does not exist.')
  const [entry]=await db.execute(sql`SELECT id FROM journal_entry WHERE id=${entryId}::uuid AND ledger_id=${ledgerId}::uuid`)
  if(!entry)throw new DocumentError('NO_RECEIPT','That payment does not exist.')
  const files=await attachmentsOf(entryId);sizeLimit(files)
  const result:ReceiptSupportingFile[]=[]
  for(const file of files) {
    try {
      const content=await attachmentFile(ledgerId,file.id)
      if(!content||createHash('sha256').update(content.bytes).digest('hex')!==file.sha256)throw new Error('Missing or damaged')
      result.push({filename:file.uploaded,mime:file.mime,bytes:content.bytes})
    } catch {throw new DocumentError('RECEIPT_SUPPORTING',`The supporting file "${file.uploaded}" is missing or damaged. Restore or replace it before exporting the Receipt.`)}
  }
  return result
}
