'use server'
import { cookies } from 'next/headers'
import { currentUser, requireLedger, SESSION_COOKIE } from '@/lib/gate'
import { editLease, EditConflict } from '@/lib/edit-leases'
import type { EditProof, EditResource } from '@/lib/edit-proof'
import { EDIT_RESOURCES } from '@/lib/edit-proof'

export async function editLeaseAction(resource: EditResource, operation: 'acquire'|'heartbeat'|'release'|'takeover', proof: EditProof) {
  if(!Object.hasOwn(EDIT_RESOURCES,resource.type))return {error:'Unknown edit resource.',status:403}
  // Unmount cleanup may finish after an intercepted route has gone away.
  // Its page URL is no longer an authorization scope; a redirect here would
  // navigate the page the user just returned to. The domain command below
  // still checks the live session/MFA, ledger/module/resource and lease owner.
  if (operation === 'release') {
    if (!await currentUser()) return {error:'Sign in again before editing.',status:403}
  } else await requireLedger(resource.ledgerId, EDIT_RESOURCES[resource.type].seat)
  try {
    if (!['acquire','heartbeat','release','takeover'].includes(operation)) return {error:'Unknown lease operation.',status:403}
    return await editLease(resource,(await cookies()).get(SESSION_COOKIE)?.value ?? '',operation,proof)
  } catch(error) {
    return {error:error instanceof Error ? error.message : 'Edit protection unavailable.',status:error instanceof EditConflict ? error.status : 403}
  }
}
