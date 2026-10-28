import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { acting, type Tx } from './acting'
import type { UserRecord } from './users'

export class OperationsError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}
export function operationId(id: string) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))
    throw new OperationsError('ID', 'Choose an available record.')
  return id
}
export function operationText(value: string, label: string, max: number, required = false) {
  const v = value.trim()
  if ((required && !v) || v.length > max) throw new OperationsError('FIELD', `${label} ${required ? 'is required and ' : ''}must be at most ${max} characters.`)
  return v
}
export function operationDate(value: string) {
  if (!/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value + 'T00:00:00Z')) || new Date(value + 'T00:00:00Z').toISOString().slice(0,10) !== value)
    throw new OperationsError('DATE', 'Enter a valid date.')
  return value
}
export function operationAmount(n: bigint) {
  if (n < 0n || n > 9_000_000_000_000_000_000n) throw new OperationsError('AMOUNT', 'Enter a non-negative amount within the supported range.')
  return n
}
/** Recheck live company/module grants inside the same locked write transaction. */
export async function operationScope(tx: Tx, me: UserRecord, ledgerId: string, seat: '/assets' | '/inventory' | '/payroll') {
  operationId(ledgerId)
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${seat + ':' + ledgerId},0))`)
  const [user] = await tx.execute<{email:string;kind:string}>(sql`SELECT email,kind FROM app_user WHERE id=${me.id}::uuid AND is_active FOR SHARE`)
  const [ledger] = await tx.execute<{entity_id:string;currency:string}>(sql`SELECT l.entity_id::text,l.currency FROM ledger l JOIN entity e ON e.id=l.entity_id
    WHERE l.id=${ledgerId}::uuid AND e.archived_at IS NULL FOR SHARE OF e,l`)
  if (!user || !ledger) throw new OperationsError('NO_ACCESS', 'This user or company is unavailable.')
  const [policy] = await tx.execute<{enabled:boolean}>(sql`SELECT enabled FROM company_module_access WHERE entity_id=${ledger.entity_id}::uuid AND module=${seat} FOR SHARE`)
  if (policy && !policy.enabled) throw new OperationsError('NO_ACCESS', 'This module is disabled for this company.')
  if (user.kind === 'user') {
    const grants = await tx.execute(sql`SELECT 1 FROM user_entity_module_access WHERE user_id=${me.id}::uuid AND entity_id=${ledger.entity_id}::uuid AND module=${seat} FOR SHARE`)
    if (!grants.length) throw new OperationsError('NO_ACCESS', 'You do not have access to this company and module.')
  }
  await acting(tx,user.email)
  return {...ledger,email:user.email}
}
export function operationWrite<T>(me: UserRecord, ledgerId: string, seat: '/assets' | '/inventory', fn: (tx:Tx,scope:Awaited<ReturnType<typeof operationScope>>) => Promise<T>) {
  return db.transaction(async tx => fn(tx,await operationScope(tx,me,ledgerId,seat)))
}
