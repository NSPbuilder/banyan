import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { cookies } from 'next/headers'
import { SESSION_COOKIE } from '@/lib/gate'
import { planningActor,planningScope } from '@/lib/planning-access'
import { ImportError } from '@/lib/import-csv'

/** The financial target and its Inbox source share one private original. */
export async function SourcePapers({ledgerId,type,id}:{ledgerId:string;type:'invoice'|'entry';id:string}) {
  const rows=await db.execute<{id:string;filename:string}>(sql`SELECT id::text,filename FROM inbox_item WHERE ledger_id=${ledgerId}::uuid
    AND ${type==='invoice'?sql`target_invoice_id=${id}::uuid`:sql`target_entry_id=${id}::uuid`} ORDER BY created_at`)
  if(!rows.length)return null
  return <section className="mt-6 border-t border-line pt-4"><h2 className="mb-2 font-medium">Original sources</h2>
    <ul className="space-y-2 text-sm">{rows.map(row=><li key={row.id}><a className="underline" href={`/ledger/${ledgerId}/${type==='invoice'?'invoices':'entries'}/${id}/source/${row.id}`}>{row.filename}</a></li>)}</ul>
  </section>
}

/** Append after existing document controls; source access uses current Opening permission. */
export async function MigrationSources({ledgerId,type,id}:{ledgerId:string;type:'invoice'|'entry';id:string}) {
  const rows=await db.transaction(async tx=>{
    try{await planningScope(tx,ledgerId,planningActor((await cookies()).get(SESSION_COOKIE)?.value??''),'/opening')}
    catch(error){if(error instanceof ImportError&&['ACCESS','MODULE'].includes(error.code))return [];throw error}
    return tx.execute<{run_id:string;file_id:string;filename:string;source_lines:number[];line_count:number;source_key:string}>(sql`
      SELECT r.run_id::text,f.id::text AS file_id,f.filename,
        (array_agg((source_row->>'line')::int ORDER BY (source_row->>'line')::int))[1:20] AS source_lines,
        count(*)::int AS line_count,r.source_key
      FROM migration_reference r CROSS JOIN LATERAL jsonb_array_elements(r.source_rows) source_row
      JOIN migration_file f ON f.id=(source_row->>'fileId')::uuid AND f.run_id=r.run_id
      WHERE r.ledger_id=${ledgerId}::uuid AND ${type==='invoice'?sql`r.invoice_id=${id}::uuid`:sql`r.entry_id=${id}::uuid`}
      GROUP BY r.run_id,r.source_key,f.id,f.filename ORDER BY f.filename,r.source_key`)
  })
  if(!rows.length)return null
  return <section className="mt-6 border-t border-line pt-4"><h2 className="mb-2 font-medium">Migration source rows</h2><ul className="space-y-2 text-sm">{rows.map(row=><li key={row.file_id+':'+row.source_key}><a className="underline" href={`/ledger/${ledgerId}/opening/migration/${row.run_id}/source/${row.file_id}`}>{row.filename} · source {row.source_lines.length===1?'line':'lines'} {row.source_lines.join(', ')}{row.line_count>20?` (${row.line_count} total; download the original for all lines)`:''}</a>{' · '}<a className="underline" href={`/ledger/${ledgerId}/opening/migration/${row.run_id}`}>Migration review</a></li>)}</ul></section>
}
