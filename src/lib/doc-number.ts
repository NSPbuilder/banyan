/**
 * The number a document is known by — ONE rule, for every screen that prints
 * one.
 *
 * **Whoever raised the document gave it its number.** A supplier bills you
 * under their own invoice number; you bill a customer under yours. The
 * direction only says which side of the paper we are standing on; it is not a
 * second rule, and each screen picking its own preference is how the invoice
 * list came to file the same bill under a different number than the expenses
 * browse showed for it (critic, 2026-09-03).
 *
 * Client-safe on purpose (no `server-only`): the invoice list is a client
 * component and must call THIS rather than repeat it.
 *
 * `entriesByParty` cannot call this — its answer is computed inside a SQL
 * aggregate, where there is no TypeScript. So the SQL states the same rule in
 * its own language and `V113` holds the two against each other, the way `V76`
 * holds `totalOf` against the invoice total's SQL.
 */
export function documentNumber(doc: {
  direction: 'sales' | 'purchase'
  number: string | null
  their_ref: string | null
}): string | null {
  // Blank is not a number: a form that posted an empty box must not beat a
  // real number on the other field.
  const ours = doc.number?.trim() || null
  const theirs = doc.their_ref?.trim() || null
  return doc.direction === 'purchase' ? theirs ?? ours : ours ?? theirs
}
