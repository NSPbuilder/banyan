import type { ReactNode } from 'react'
import { WorkspaceNavigation } from './WorkspaceNavigation'

/** Shared by company modules and workspace administration. Keep the modal
 * beside the navigation/content siblings for OverlayPanel's focus guard. */
export function ApplicationFrame({ navigation, context, search, children, modal }: {
  navigation: ReactNode
  context: { name: string; code?: string; currency?: string }
  search?: ReactNode
  children: ReactNode
  modal?: ReactNode
}) {
  return <WorkspaceNavigation>
    <div className="ledger-workspace flex min-h-screen">
      {navigation}
      <div data-ledger-content className="ledger-canvas min-h-full min-w-0 flex-1">
          <header className="workspace-tools print:hidden" aria-label="Workspace context">
            <div className="workspace-context min-w-0 flex items-center gap-3">
              {context.code && <span className="text-metadata text-ink-muted">{context.code}</span>}
              <span className="min-w-0 truncate text-label font-medium text-ink" title={context.name}>{context.name}</span>
              {context.currency && <span className="workspace-currency text-metadata text-ink-secondary" title="Ledger currency">{context.currency}</span>}
            </div>
            {search && <div className="workspace-search">{search}</div>}
          </header>
        <div className="ledger-canvas-wrap min-w-0 overflow-x-auto">
          {children}
        </div>
      </div>
      {modal}
    </div>
  </WorkspaceNavigation>
}
