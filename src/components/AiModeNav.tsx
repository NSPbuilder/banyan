import Link from 'next/link'

/** The two deliberately different workflows behind the one + AI entry. */
export function AiModeNav({ ledgerId, active, showAsk = true,showRead=true,showInbox=false }: {
  ledgerId: string
  active: 'ask' | 'read' | 'inbox'
  showAsk?: boolean
  showRead?:boolean
  showInbox?:boolean
}) {
  const base = 'rounded-md px-3 py-2 text-sm transition-colors'
  const activeClass = 'bg-clay-600 font-semibold text-white'
  const quietClass = 'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800'

  return (
    <nav aria-label="AI workspace modes"
         className="mt-5 flex flex-wrap gap-2 border-b border-neutral-200 pb-3 dark:border-neutral-800">
      {showAsk && (
        <Link href={`/ledger/${ledgerId}/assistant`}
              aria-current={active === 'ask' ? 'page' : undefined}
              className={`${base} ${active === 'ask' ? activeClass : quietClass}`}>
          Ask Banyan
        </Link>
      )}
      {showRead&&<Link href={`/ledger/${ledgerId}/readings`}
            aria-current={active === 'read' ? 'page' : undefined}
            className={`${base} ${active === 'read' ? activeClass : quietClass}`}>
        Read &amp; add
      </Link>}
      {showInbox&&<Link href={`/ledger/${ledgerId}/readings/inbox`} aria-current={active==='inbox'?'page':undefined} className={`${base} ${active==='inbox'?activeClass:quietClass}`}>Inbox</Link>}
    </nav>
  )
}
