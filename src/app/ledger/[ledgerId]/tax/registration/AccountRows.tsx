import { AccountRow, type ProposedRow } from './AccountRow'

/**
 * Every proposed account, numbered.
 *
 * Its own component for one reason: the index each row is given is part of the
 * contract with the handler, and while that `map` sat inside `RegisterForm` —
 * which imports a server action and so cannot be rendered by a test — nothing
 * observed it. Changing `index={i}` to `index={i + 1}` put the owner's payable
 * code and name onto their recoverable account, created the payable from the
 * system default, and reported success naming the swapped pair. One character,
 * all forty-nine checks green.
 *
 * `AccountRow` was already renderable and already checked. That covered which
 * field a box posts under, and said nothing about which row it belongs to.
 */
export function AccountRows({ proposed, tax }: { proposed: ProposedRow[]; tax: string }) {
  return (
    <div className="mt-3 space-y-3">
      {proposed.map((row, i) => (
        <AccountRow key={row.code} row={row} index={i} tax={tax} />
      ))}
    </div>
  )
}
