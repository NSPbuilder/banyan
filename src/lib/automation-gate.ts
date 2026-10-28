import 'server-only'
import { requireLedger } from './gate'
/** Existing gate arrays mean ANY. P2 workspaces require every named seat. */
export async function requireAutomationLedger(ledgerId:string,seats:string[]=[]) {
  const me=await requireLedger(ledgerId,'/automation')
  for(const seat of seats)await requireLedger(ledgerId,seat)
  return me
}
