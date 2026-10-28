import type { Sql } from 'postgres'

/** Compare every column that actually existed before an additive upgrade. */
export async function legacyFinancialColumns(connection: Sql, tables: readonly string[]) {
  const columns: Record<string, string[]> = {}
  for (const table of tables) {
    if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw Error('Unsafe legacy fixture table')
    const rows = await connection`SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name=${table} ORDER BY ordinal_position`
    if (!rows.length) throw Error('Missing legacy fixture table: ' + table)
    columns[table] = rows.map(r => String(r.column_name))
  }
  return columns
}

/** Seed only columns shared by the old upgrade schemas. Current ORM models
 * include later FX columns and must not be used before applying that migration.
 * This uses the balanced header/line transaction exercised by db/test/smoke.sql.
 */
export async function seedLegacyFinancialFixture(connection: Sql, input: {
  entityId: string; ledgerId: string; actor: string; date: string; description: string; draft?: boolean
}) {
  return connection.begin(async tx => {
    const [period] = await tx`SELECT id FROM fiscal_period WHERE ledger_id=${input.ledgerId}::uuid
      AND start_date<=${input.date}::date AND end_date>=${input.date}::date`
    if (!period) throw Error('Legacy fixture needs its actual fiscal period')
    const accounts = await tx`INSERT INTO account(entity_id,code,name,account_type,normal_balance,is_postable)
      VALUES(${input.entityId}::uuid,'1000','Cash','asset','debit',true),
            (${input.entityId}::uuid,'5000','Expenses','expense','debit',true) RETURNING id,code`
    const cash = accounts.find(a => a.code === '1000')!, expense = accounts.find(a => a.code === '5000')!
    await tx`INSERT INTO account_role(account_id,role) VALUES(${cash.id},'cash_and_cash_equivalents'),(${expense.id},'other_operating_expenses')`
    const [entry] = await tx`INSERT INTO journal_entry(ledger_id,entry_no,entry_date,period_id,description,
      source_type,status,total_debit,total_credit,posted_at,posted_by)
      VALUES(${input.ledgerId}::uuid,'JE-00001',${input.date}::date,${period.id},${input.description},
        'manual','posted',12345,12345,${input.date}::timestamptz,${input.actor}) RETURNING id`
    await tx`INSERT INTO journal_line(entry_id,line_no,account_id,amount) VALUES
      (${entry.id},1,${cash.id},-12345),(${entry.id},2,${expense.id},12345)`
    await tx`INSERT INTO number_sequence(entity_id,doc_type,fiscal_year,prefix,next_number)
      VALUES(${input.entityId}::uuid,'JE','ALL','JE-',2)`
    let draftId: string | undefined
    if (input.draft) {
      const [draft] = await tx`INSERT INTO journal_entry(ledger_id,entry_date,description,source_type,status,total_debit,total_credit)
        VALUES(${input.ledgerId}::uuid,${input.date}::date,'Recurring source','manual','draft',12345,12345) RETURNING id`
      await tx`INSERT INTO journal_line(entry_id,line_no,account_id,amount) VALUES
        (${draft.id},1,${cash.id},-12345),(${draft.id},2,${expense.id},12345)`
      draftId = String(draft.id)
    }
    return { entryId: String(entry.id), draftId }
  })
}
