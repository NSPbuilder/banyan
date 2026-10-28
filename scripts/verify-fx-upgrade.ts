/** Upgrade an owned pre-FX database; never alter the application's database. */
import './env'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import postgres from 'postgres'

async function main() {
  const confirmed = new URL(process.env.TEST_DATABASE_URL!)
  assert.equal(confirmed.pathname.slice(1),process.env.TEST_DATABASE_CONFIRMATION)
  const target=new URL(confirmed),adminUrl=new URL(confirmed)
  const name=`figtree_fx_upgrade_${Date.now()}_test`
  target.pathname='/'+name;adminUrl.pathname='/postgres'
  const admin=postgres(adminUrl.href,{max:1})
  let fixture:ReturnType<typeof postgres>|undefined,created=false
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);created=true
    fixture=postgres(target.href,{max:1})
    await fixture`CREATE TABLE _migration(filename text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`
    for (const filename of readdirSync('db/migrations').filter(f=>f.endsWith('.sql')&&f<'0158').sort()) {
      const body=readFileSync('db/migrations/'+filename,'utf8')
      await fixture.begin(async tx=>{await tx.unsafe(body);await tx`INSERT INTO _migration(filename,checksum) VALUES(${filename},${createHash('sha256').update(body).digest('hex').slice(0,16)})`})
    }
    // Reuse the existing balanced CAD kernel fixture, before its first assertion.
    const smoke=readFileSync('db/test/smoke.sql','utf8')
    const seed=smoke.slice(smoke.indexOf('INSERT INTO entity'),smoke.indexOf('SELECT t_assert'))
    assert(seed.includes('Initial share capital'))
    await fixture.unsafe(seed)
    await fixture.begin(async tx=>{
      const [party]=await tx`INSERT INTO party(kind,name) VALUES('organisation','Pre-FX Customer') RETURNING id`
      await tx`INSERT INTO party_role(party_id,entity_id,role,held_from) VALUES(${party.id},'11111111-1111-1111-1111-111111111111','customer','2026-01-01')`
      const [invoice]=await tx`INSERT INTO invoice(entity_id,ledger_id,direction,party_id,number,issued_on,due_on,control_account_id)
        VALUES('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001','sales',${party.id},'PRE-FX','2026-02-01','2026-02-28','cccccccc-0000-0000-0000-000000001200') RETURNING id`
      await tx`INSERT INTO invoice_line(invoice_id,line_no,account_id,amount) VALUES(${invoice.id},1,'cccccccc-0000-0000-0000-000000004000',-12345)`
    })
    const [before]=await fixture`SELECT
      (SELECT jsonb_agg(to_jsonb(j) ORDER BY j.id) FROM journal_line j) AS journal,
      (SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id) FROM invoice i) AS invoice,
      (SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id) FROM invoice_line i) AS detail`
    await fixture.begin(async tx=>{await tx.unsafe(readFileSync('db/migrations/0158_core_fx.sql','utf8'))})
    const [after]=await fixture`SELECT
      (SELECT jsonb_agg(to_jsonb(j)-'original_currency'-'original_amount'-'fx_snapshot'-'fx_invoice_id' ORDER BY j.id) FROM journal_line j) AS journal,
      (SELECT jsonb_agg(to_jsonb(i)-'fx_currency'-'fx_snapshot'-'fx_request_key' ORDER BY i.id) FROM invoice i) AS invoice,
      (SELECT jsonb_agg(to_jsonb(i)-'original_amount' ORDER BY i.id) FROM invoice_line i) AS detail`
    assert.deepEqual(after,before)
    const [counts]=await fixture`SELECT (SELECT count(*) FROM fx_currency)::int AS catalog,(SELECT count(*) FROM fx_company_currency)::int AS policies,
      (SELECT count(*) FROM journal_line WHERE original_currency IS NOT NULL)::int AS converted`
    assert(counts.catalog>=28);assert.equal(counts.policies,0);assert.equal(counts.converted,0)
    console.log('PASS  FX-UPGRADE pre-FX CAD journal, draft invoice and lines remain byte-equivalent; no currency is implicitly enabled')
    console.log('=== ALL CHECKS PASSED (1 FX upgrade check) ===')
  } finally {
    await fixture?.end()
    if(created)await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`)
    await admin.end()
  }
}
main().catch(e=>{console.error(e);process.exitCode=1})
