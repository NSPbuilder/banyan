/**
 * The calendar day here, as the person reading the screen would name it.
 *
 * `new Date().toISOString().slice(0, 10)` is the UTC day, which is not the same
 * thing west of Greenwich. This machine is in Vancouver: from 17:00 local
 * (16:00 in winter) until midnight, the UTC day is already tomorrow. A
 * registration ended effective today then read as already ended — an "ended"
 * badge, "Correct the date it ended" instead of "Change the date it ends", and
 * a fresh registration form offered for a tax the company is still registered
 * for. Seven hours of every day, on the only machine this runs on.
 *
 * Sales tax registration is a matter of calendar days in a jurisdiction, so the
 * local day is the correct one, not a convenience.
 */
export function dayIn(at: Date): string {
  // en-CA formats as YYYY-MM-DD, which is what every date column here holds.
  return at.toLocaleDateString('en-CA')
}

/**
 * The instant is a parameter on `dayIn` so this can be checked at a moment of
 * the test's choosing. Checked only against `new Date()`, the difference
 * between the local day and the UTC day is invisible for seventeen hours out of
 * every twenty-four — the suite would pass all morning and the bug would be
 * waiting each evening.
 */
export function localToday(): string {
  return dayIn(new Date())
}

/**
 * A timestamp for a filename, in local time: `20260822-164500`.
 *
 * The backup download used the UTC clock, so a backup taken at 4:45pm here was
 * named 2345. Nobody looking for it would think to search for that. This is a
 * label a person reads, so it is their clock that matters.
 */
export function localStamp(at = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}`
       + `-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`
}

/**
 * A moment, here: `2026-08-22 16:45:00`.
 *
 * For a timestamp a PERSON reads — when a backup was taken, when a file was
 * made. `new Date().toISOString()` is the same instant and reads as a
 * different evening to anybody west of Greenwich, which is the whole of this
 * country. The first ten characters are the local day, so anything that wants
 * only the date can take them.
 */
export function localMoment(at = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`
       + ` ${p(at.getHours())}:${p(at.getMinutes())}:${p(at.getSeconds())}`
}

/**
 * The calendar parts of a day, here.
 *
 * Anything that asks "what year is it" or "has that date passed yet" has to ask
 * the local clock, for the same reason `localToday` does. `filingPeriods` used
 * `getUTCFullYear()`, so on the evening of 31 December it offered the quarters
 * of the year that had not started — the Q4 the person was actually filing was
 * not on the list. `currentYearEnd` used it too, and gave a company created
 * that evening a fiscal year a year out, which is the exact failure its own
 * comment says it exists to prevent.
 */
export function partsOf(at: Date): { year: number; month: number; day: number } {
  return { year: at.getFullYear(), month: at.getMonth() + 1, day: at.getDate() }
}
