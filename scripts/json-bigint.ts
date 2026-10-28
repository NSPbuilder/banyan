/**
 * JSON that survives money.
 *
 * The render scripts run in their own process because `react-dom/server` will
 * not load under `--conditions=react-server` and `server-only` throws without
 * it. So the suite fetches and the renderer renders, and everything between
 * them goes through `JSON` — which has no idea what a BigInt is and throws
 * rather than guessing.
 *
 * Both directions live here, in one file, for the same reason `bank-wire.ts`
 * holds both directions of the import payload: a writer and a reader in
 * separate files are one rule spelled twice.
 */

const MARK = '$bigint'

export function stringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    (typeof v === 'bigint' ? { [MARK]: v.toString() } : v))
}

export function parse<T>(text: string): T {
  return JSON.parse(text, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const keys = Object.keys(v as object)
      if (keys.length === 1 && keys[0] === MARK) return BigInt((v as Record<string, string>)[MARK])
    }
    return v
  }) as T
}
