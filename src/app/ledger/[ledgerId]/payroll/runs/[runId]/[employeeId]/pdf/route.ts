import { guardRoute } from '@/lib/gate'
import { paychequePdf } from '@/lib/payroll/paycheque'

export const dynamic = 'force-dynamic'

/**
 * One employee's pay stub for one payday.
 *
 * Reached from the row that is about it — on the pay run's page, and on the
 * employee's own page, which is where somebody looks when they are asked for
 * a copy of one payday. Bound to the ledger like every other read here: the
 * run and the stub must both belong to this company or there is no document.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ ledgerId: string; runId: string; employeeId: string }> },
) {
  const who = await guardRoute()
  if (who instanceof Response) return who

  const { ledgerId, runId, employeeId } = await params
  const doc = await paychequePdf(ledgerId, runId, employeeId)
  if (!doc) return new Response('No pay stub for that person on that run.', { status: 404 })
  return new Response(new Uint8Array(doc.buffer), {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `inline; filename="${doc.filename}"`,
    },
  })
}
