import { actingAs, type Tx } from '../src/lib/acting'

/**
 * A write a suite makes with its own hands — a period closed by UPDATE, a
 * draft moved to another ledger, an invoice's status forged — to put the
 * database into a state no door would produce, and then watch a guard refuse.
 *
 * That is the psql case, and an audit trigger firing under it names the
 * Postgres role, which is the truth. But every suite that touches such a
 * table ends by asking whether ANY row names the role (`trailNamesPeople`),
 * because a row that does is otherwise an application door that never said
 * who was acting — the defect 0060 closes. So the hand says it is a hand:
 * the same `acting()` mechanism, with a name no person has. A row that says
 * 'check (by hand)' is a suite's; a row that says the role is a finding.
 */
export const BY_HAND = 'check (by hand)'
export const byHand = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => actingAs(BY_HAND, fn)
