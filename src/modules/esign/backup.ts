import { randomUUID } from 'node:crypto'

export function restoreRow(table: string, value: Record<string, unknown>) {
  if (table === 'esign_request') return { ...value, operation: 'DETACHED', connection_id: null, last_error: null }
  if (table === 'esign_document') return { ...value, submission_key: randomUUID() }
  return value
}
