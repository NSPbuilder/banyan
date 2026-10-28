import { headers } from 'next/headers'
import { requireOwner } from '@/lib/gate'
import { connectionSummary, signingSecretReady } from '@/lib/esign'
import { SigningConnectionForm } from './DocumensoConnectionForm'
import { connectDocumensoAction } from './documenso-actions'

export async function DocumensoSettings({ ledgerId, company }: { ledgerId: string; company: { id: string; name: string; archived_at: string | null } }) {
  await requireOwner()
  const connection = await connectionSummary(company.id), head = await headers()
  const host = head.get('x-forwarded-host') || head.get('host') || ''
  const protocol = head.get('x-forwarded-proto') === 'https' ? 'https' : 'http'
  const webhookUrl = connection ? `${protocol}://${host}/api/documenso/${connection.id}` : null
  return <section id="documenso" className="mt-8 max-w-2xl border-t border-neutral-200 pt-6 dark:border-neutral-800">
    <h2 className="text-lg font-semibold">Documenso</h2>
    <p className="mt-1 text-sm text-neutral-500">{company.name} · {connection?.enabled && connection.readable ? 'Connected' : 'Not connected'}</p>
    {!signingSecretReady() && <p className="mt-3 text-sm text-amber-700 dark:text-amber-300">The administrator must configure DOCUMENSO_KEY_SECRET before a token can be saved.</p>}
    {connection && !connection.readable && <p className="mt-3 text-sm text-amber-700 dark:text-amber-300">The saved token cannot be read. Enter it again to reconnect.</p>}
    {company.archived_at ? <p className="mt-3 text-sm text-neutral-500">Archived company · Read-only</p> : <SigningConnectionForm ledgerId={ledgerId} connection={connection} action={connectDocumensoAction}/>}
    {webhookUrl && <details className="mt-4 text-sm"><summary className="cursor-pointer text-neutral-500">Webhook setup</summary><div className="mt-3 space-y-2"><code className="block break-all rounded bg-neutral-100 p-2 text-xs dark:bg-neutral-800">{webhookUrl}</code><p className="text-xs text-neutral-500">In Documenso Settings → Webhooks, add this URL and your secret. Enable document events.</p></div></details>}
  </section>
}
