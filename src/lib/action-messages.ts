import 'server-only'

import { AccountError } from './accounts'
import { EditConflict } from './edit-leases'
import { FormError } from './forms'
import { reconciledSentence } from './match-forms'
import { PeriodError } from './periods'
import { PostingError } from './posting'
import { SetupError } from './setup'

/** Surface the reason, not a stack trace — including the ones Postgres raises. */
export function messageFor(e: unknown): string {
  if (e instanceof EditConflict) return e.message
  if (e instanceof PostingError || e instanceof AccountError || e instanceof SetupError
      || e instanceof FormError || e instanceof PeriodError) {
    return e.message
  }
  if (e instanceof Error) {
    const cause = (e.cause as Error | undefined)?.message
    const text = cause ?? e.message
    // Deleting an entry releases its bank matches (posting.ts), and a match
    // inside a finished reconciliation refuses to be released (0055).
    return reconciledSentence(text) ?? text.split('\n')[0]
  }
  return String(e)
}
