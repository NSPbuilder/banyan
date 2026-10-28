import 'server-only'
import { entryHeaderFrom, linesFromJson } from './forms'
import type { EditContext } from './edit-proof'
import { withDocumentWrite } from './edit-leases'
import { db } from '@/db/client'
import type { Runner } from './acting'
import { saveThenPost } from './posting'
import { attachIfAny } from './attach-forms'
import { expandTaggedLines } from './tagged-line'

/**
 * The journal entry form's rows, read and then expanded.
 *
 * Two steps that must always happen together: `linesFromJson` turns the
 * screen's JSON into lines and says how many incomplete rows it dropped;
 * `expandTaggedLines` splits any row the person tagged with a tax into the
 * net and the tax, inclusive. Separate, one of the three doors that read this
 * form would eventually do the first and not the second, and a tagged entry
 * would post with the tax silently inside the account it was typed against.
 *
 * Here rather than in `app/actions.ts` for the reason every *-forms.ts is: a
 * check can call this and cannot call a server action.
 */
export async function entryLinesFrom(ledgerId: string, json: string, on: string) {
  const { lines, dropped } = linesFromJson(json)
  return { lines: await expandTaggedLines(ledgerId, lines, on), dropped }
}

/**
 * Post what the journal entry form sent, and file the paper that came with
 * it. Here rather than in `app/actions.ts` because a check can call this and
 * cannot call a server action — and because the attach step has a rule of its
 * own (after the posting, never fatal) that ought to be watched.
 */
export async function postEntryFromForm(
  f: FormData, input: { ledgerId: string; entryId?: string; actor: string }, context?: EditContext,
): Promise<{ ok?: string; error?: string; entryId?: string; version?: string }> {
  const { lines } = await entryLinesFrom(input.ledgerId, String(f.get('lines') ?? '[]'),
                                         String(f.get('entryDate') ?? ''))
  const command = (on: Runner, actor: string) => saveThenPost({
    ledgerId: input.ledgerId,
    ...entryHeaderFrom(f),
    actor,
    lines,
  }, input.entryId,on)
  const result = context && input.entryId ? await withDocumentWrite({ledgerId:input.ledgerId,type:'entry',id:input.entryId},context,command) : await command(db,input.actor)
  if (!result.ok) return { error: result.error, entryId: result.entryId, version: result.version }
  const paper = await attachIfAny(f, { ledgerId: input.ledgerId, entryId: result.entryId, actor: input.actor })
  return { ok: `Posted as ${result.entryNo}.${paper}`, entryId: result.entryId, version:result.version }
}
