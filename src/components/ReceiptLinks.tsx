import { QUIET } from '@/lib/ui'

/** Open the receipt PDF separately so the originating form stays in place. */
export function ReceiptLinks({ href, className = QUIET }: { href: string; className?: string }) {
  return <span className="inline-flex items-center" data-receipt-links>
    <a href={href} target="_blank" rel="noopener" className={className}>Receipt</a>
  </span>
}
