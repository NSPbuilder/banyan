import 'server-only'
import { reportPdf, type PdfBlock } from '@/lib/pdf'
import { filename } from '@/lib/csv'
import { renderRegisterForLedger, type Audience, type RegisterKind } from '@/lib/registers'

/** Returns the entity too, so the route can write the export trail the
 *  register page writes — without rendering a second time. */
export async function registerPdf(
  ledgerId: string, kind: RegisterKind, asOf: string, audience: Audience,
): Promise<{ filename: string; buffer: Buffer; entityId: string } | null> {
  const rendered = await renderRegisterForLedger(kind, ledgerId, asOf, audience)
  if (!rendered) return null
  const r = rendered.register

  const blocks: PdfBlock[] = [
    ...r.headerNotes.map((n): PdfBlock => ({ kind: 'note', text: n })),
    {
      kind: 'table',
      columns: r.columns.map((label) => ({ label })),
      rows: r.rows.map((cells) => ({ cells: [...cells] })),
    },
  ]
  // The register's second table, when it has one — the same structure the
  // preview draws, so the particulars cannot be on one exit and not the other.
  if (r.detail) {
    blocks.push({ kind: 'note', text: r.detail.title })
    blocks.push({
      kind: 'table',
      columns: r.detail.columns.map((label) => ({ label })),
      rows: r.detail.rows.map((cells) => ({ cells: [...cells] })),
    })
  }
  if (r.withheld.length > 0) {
    blocks.push({ kind: 'note', text:
      `Withheld from this audience: ${r.withheld.join(', ')}.` })
  }

  return {
    entityId: rendered.entityId,
    filename: filename([r.entityName, r.title, asOf, audience], 'pdf'),
    buffer: await reportPdf({
      company: r.entityName,
      title: r.title,
      subtitle: [`As at ${asOf} · ${audience === 'public' ? 'public inspection copy' : "director's copy"}`],
    }, blocks),
  }
}

