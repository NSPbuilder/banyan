import { guardRoute } from '@/lib/gate'
import { crmCsv } from '@/lib/crm'
import { filename } from '@/lib/csv'

const KINDS = new Set(['accounts', 'leads', 'opportunities', 'tasks'])

export async function GET(
  request: Request,
  { params }: { params: Promise<{ ledgerId: string }> },
) {
  const who = await guardRoute()
  if (who instanceof Response) return who
  const { ledgerId } = await params
  const asked = new URL(request.url).searchParams.get('what') ?? ''
  if (!KINDS.has(asked)) return new Response('Unknown CRM export.', { status: 400 })
  try {
    const body = await crmCsv(ledgerId, asked as 'accounts' | 'leads' | 'opportunities' | 'tasks')
    return new Response(body, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename(['crm', asked])}"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch {
    return new Response('CRM export failed.', { status: 500 })
  }
}
