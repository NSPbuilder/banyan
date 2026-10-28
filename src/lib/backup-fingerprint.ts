/**
 * What a database IS, reduced to figures that must survive a restore.
 *
 * The restore check used to compare eleven figures over eight tables — the
 * ledger kernel — so payroll, SR&ED, the attachments and the corporate
 * registers could come back empty and the check would say the backup was
 * good. Now every table in the database is a figure, taken from the catalogue
 * at run time so a table added tomorrow is in the comparison tomorrow, and the
 * money is summed as well: two tables can hold the same number of rows and
 * different figures.
 */

/** Every table in the public schema, in a fixed order. */
export const TABLES_SQL = `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`

/** The sums that a row count cannot stand in for. */
const MONEY = [
  ['journal_line.amount', 'COALESCE(SUM(amount), 0)', 'journal_line'],
  ['journal_line.debit', 'COALESCE(SUM(debit), 0)', 'journal_line'],
  ['journal_line.credit', 'COALESCE(SUM(credit), 0)', 'journal_line'],
  ['attachment_blob.bytes', 'COALESCE(SUM(byte_size), 0)', 'attachment_blob'],
] as const

/**
 * One SQL text, run on both sides, printing `name|value` per line: a row count
 * for every table named, then the sums. The list is handed in so the two sides
 * are asked the same question — the restored copy is asked about the live
 * database's tables, and a table it lacks is an error, not a silent omission.
 */
export function fingerprintSql(tables: string[]): string {
  // The names come from the catalogue, not from anyone's input; quoted and
  // escaped all the same, so a name with a quote in it is a figure, not a
  // broken query.
  const lit = (t: string) => `'${t.replace(/'/g, "''")}'`
  const ident = (t: string) => `"${t.replace(/"/g, '""')}"`
  const counts = tables.map((t) => `SELECT ${lit(t)} AS name, count(*)::text AS value FROM ${ident(t)}`)
  const sums = MONEY.filter(([, , table]) => tables.includes(table))
    .map(([name, expr, table]) => `SELECT ${lit(name)} AS name, ${expr}::text AS value FROM ${ident(table)}`)
  return `SELECT name, value FROM (\n${[...counts, ...sums].join('\nUNION ALL\n')}\n) AS f ORDER BY name`
}

/** psql's `-tA` output of `fingerprintSql`, read back. */
export function parseFingerprint(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of text.split('\n')) {
    const i = line.indexOf('|')
    if (i > 0) out.set(line.slice(0, i), line.slice(i + 1))
  }
  return out
}

/** The names whose figures differ, each with both sides, for the FAIL line. */
export function fingerprintDifferences(live: Map<string, string>, restored: Map<string, string>): string[] {
  const out: string[] = []
  for (const [name, value] of live) {
    const other = restored.get(name)
    if (other !== value) out.push(`${name}: books ${value} vs restored ${other ?? '(missing)'}`)
  }
  return out
}
