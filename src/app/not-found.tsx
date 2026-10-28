import { WayOut } from './WayOut'

/**
 * WHAT A PERSON SEES WHEN THE THING IS NOT THERE.
 *
 * There was no such file until now, and there are 55 `notFound()` calls — so
 * every one of them landed on Next's built-in 404, which has no rail, no link
 * and no sentence. Inside the desk that is a dead end: the desk remembers each
 * tab's current url in localStorage and re-opens it on every reload, so a tab
 * that reached a 404 came back to it forever. The owner deleted a party, the
 * page it was deleted from became a 404, and the only way out they found was
 * clearing the browser's storage (2026-09-15).
 *
 * The delete doors were fixed to leave the page they destroy — but this had to
 * exist as well, because that class is not only about deletes. A company
 * removed on one tab, a bookmark kept from before a year was reset, an address
 * typed wrong: all of them arrive here, and all of them need a door.
 *
 * ONE BOUNDARY, deliberately. A second one under `/ledger/[ledgerId]` was
 * tried first, so that a dead address inside a company would keep the rail —
 * and it does the opposite: that segment carries the `@modal` parallel slot,
 * and a `not-found.tsx` anywhere beneath it renders with no company shell at
 * all (page pass, 2026-09-15). So this one catches everything: unmatched
 * urls, a record deleted out from under a page, and a ledger id that names no
 * company — which the shell itself throws for.
 *
 * `not-found.tsx` takes no props in Next 16 (the file convention says so
 * outright), so nothing here can name what was missing. It says the true thing
 * it can say, and `WayOut` reads the company off the url so that the way back
 * is into the books rather than out to the front door.
 */
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center p-8 font-sans">
      <h1 className="text-2xl font-semibold tracking-tight">Not here</h1>
      <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
        There is nothing at this address. Either it never existed, or what was here has been
        deleted or removed since the link was made — a party, an entry, a document, a whole
        company.
      </p>
      <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
        Nothing is wrong with the books. This is one address, not a report.
      </p>
      <WayOut />
    </main>
  )
}
