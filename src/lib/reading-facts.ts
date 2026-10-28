/**
 * THE FACTS A READING CARRIES, matched to the fields a screen has.
 *
 * A model reading a certificate of incorporation answers with `facts` — an
 * open map, so a destination added tomorrow needs no new field on `Proposal`
 * (src/lib/destinations.ts). The cost of open is that the keys are the
 * model's: it may say `businessNumber`, `business_number`, `BN` or
 * `Business Number` for one thing. This is where that is absorbed, ONCE,
 * rather than in each screen that reads a fact.
 *
 * Nothing here decides anything. It fills a form in for a person to check,
 * which is the same promise every other reading makes: 「然后交给人类来审核
 * 确认」.
 *
 * Pure and client-safe, so a check calls it directly.
 */

/** Fold a key to letters only, lowercased: `Business Number` and `business_number` meet here. */
const plain = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, '')

/**
 * The first fact whose key matches one of `names`, or null.
 *
 * Names are given in the caller's preferred order, so a document stating both
 * a number and a name resolves to the one that screen actually wants.
 */
export function factOf(facts: Record<string, string>, names: string[]): string | null {
  const folded = new Map(Object.entries(facts).map(([k, v]) => [plain(k), v]))
  for (const n of names) {
    const hit = folded.get(plain(n))
    if (hit) return hit
  }
  return null
}

/** A date the profile form can take, or null — a fact that is not one is not guessed at. */
export const dateFact = (v: string | null): string | null =>
  v && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : null

export type CompanyProfileFacts = {
  incorporation_number: string | null
  business_number: string | null
  recognition_date: string | null
  company_type: string | null
}

/**
 * What a registration document says, in the profile form's own words.
 *
 * `company_type` is deliberately NOT mapped from free text: the form offers a
 * list from the `company_type` table and a value outside it would be refused
 * by the database. A person picks it; the model's word for it is shown beside
 * the form as something read but not placed.
 */
export function companyProfileFrom(facts: Record<string, string>): CompanyProfileFacts {
  return {
    incorporation_number: factOf(facts, ['incorporationNumber', 'incorporation no', 'corporationNumber', 'registrationNumber']),
    business_number: factOf(facts, ['businessNumber', 'bn', 'craBusinessNumber']),
    recognition_date: dateFact(factOf(facts, ['recognitionDate', 'incorporationDate', 'dateOfIncorporation', 'registeredOn'])),
    company_type: null,
  }
}

/** Which facts a screen took, so the rest can be shown as read-but-not-placed. */
export function unplacedFacts(
  facts: Record<string, string>, taken: Array<string | null>,
): Array<[string, string]> {
  const used = new Set(taken.filter((v): v is string => v !== null))
  return Object.entries(facts).filter(([, v]) => !used.has(v))
}
