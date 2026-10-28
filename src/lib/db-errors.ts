/**
 * What the database actually said.
 *
 * Under this driver a failed statement arrives as an Error whose own `.message`
 * is "Failed query: INSERT INTO …" — the trigger's RAISE and the constraint's
 * name are on `cause`, one or two levels down. Reading only `.message` finds
 * neither, and the code that does it looks completely reasonable.
 *
 * ONE SPELLING. This had grown three: `causesOf` in parties.ts, `fullMessage`
 * in payroll/employees.ts, and a fourth about to be written for users.ts. Each
 * was written because the author hit the same surprise and did not know the
 * others existed — which is the two-lists defect wearing an error handler.
 *
 * It has cost real time: every one of them was written AFTER a refusal that was
 * firing correctly was read as no refusal at all.
 *
 * No `server-only`: a check script reads driver errors too, and importing
 * `server-only` here would put this out of their reach.
 */
export function causesOf(e: unknown, depth = 5, sep = ' | '): string {
  const parts: string[] = []
  let cur: unknown = e
  for (let i = 0; cur && i < depth; i++) {
    const err = cur as { message?: string; cause?: unknown }
    if (err.message) parts.push(err.message)
    cur = err.cause
  }
  return parts.length > 0 ? parts.join(sep) : String(e)
}
