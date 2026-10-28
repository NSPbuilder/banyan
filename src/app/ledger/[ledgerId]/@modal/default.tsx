/**
 * No overlay unless an intercepting route matched.
 *
 * Not gated, and named in `N14`: it returns null, reads nothing, and sits
 * under the ledger layout which IS gated. A gate here would be a second answer
 * to a question already answered one level up.
 */
export default function Default() {
  return null
}
