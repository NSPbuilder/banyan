import { requireUser } from '@/lib/gate'

/**
 * Parallel slots retain their active content on soft navigation when the new
 * URL has no matching slot route. Match every non-intercepted ledger page and
 * render nothing so a modal cannot remain over the page we navigated to.
 */
export default async function DismissModal() {
  await requireUser()
  return null
}
