import { sql } from 'drizzle-orm'
import { readProjectBlob, writeProjectBlob } from '@/lib/project-attachments'
import type { BackupRows, ModuleRestoreContext, ModuleFileRestoreContext } from '@/lib/module-extensions'
import type { Tx } from '@/lib/acting'
import { BackupError } from '@/lib/backup'
import type { FigtreeFile } from '@/lib/backup'

export const backupParties = (entityId: string) => [
  sql`SELECT customer_party_id FROM project WHERE entity_id=${entityId}::uuid`,
  sql`SELECT party_id FROM project_record WHERE entity_id=${entityId}::uuid`,
  sql`SELECT party_id FROM project_payment WHERE entity_id=${entityId}::uuid`,
]
export async function backupFiles(rows: BackupRows, entityId: string): Promise<FigtreeFile['files']> {
  const files: FigtreeFile['files'] = []
  for (const b of rows.project_attachment_blob ?? []) {
    let bytes: Buffer | null = null
    try { bytes=await readProjectBlob(entityId,String(b.project_id),String(b.sha256)) } catch { /* report partial paper */ }
    if (bytes) files.push({sha256:String(b.sha256),bytes:bytes.toString('base64'),mime:String(b.mime),size:bytes.length,storageDomain:'project',projectId:String(b.project_id)})
  }
  return files
}

export async function afterRestore(tx: Tx, { rows, map }: ModuleRestoreContext) {
  for (const row of rows.project ?? []) await tx.execute(sql`SELECT project_validate(${map.get(String(row.id))!}::uuid)`)
}
export async function restoreFile(file: FigtreeFile['files'][number], context?: ModuleFileRestoreContext) {
  if (file.storageDomain !== 'project') return false
  const id = context?.maps.projectMap?.[file.projectId ?? '']
  if (!context || !id) throw new BackupError('PROJECT_FILES', 'Project file restoration needs the new company and project identifiers.')
  await writeProjectBlob(context.entityId, id, file.sha256, Buffer.from(file.bytes, 'base64'))
  return true
}
