/** Client-safe shared UI primitives. Visual roles resolve through
 * design-tokens.css; screens supply layout and business behavior. */
const BUTTON_BASE =
  'ui-button inline-flex min-h-control items-center justify-center gap-2 rounded-control border '
  + 'px-3 py-1 text-body font-medium transition-colors focus-visible:outline-2 '
  + 'focus-visible:outline-offset-2 focus-visible:outline-focus '
  + 'disabled:cursor-not-allowed disabled:border-line-subtle disabled:bg-surface-secondary disabled:text-ink-disabled'

/** One prominent committing action per page or form. */
export const BUTTON = BUTTON_BASE
  + ' border-transparent bg-action text-action-ink hover:bg-action-hover active:bg-action-active'

export const BUTTON_WIDE = BUTTON.replace('px-3', 'px-4')

/** Secondary actions keep the same control geometry without the accent fill. */
export const QUIET = BUTTON_BASE
  + ' border-line bg-surface text-ink-secondary hover:bg-surface-hover hover:text-ink active:bg-surface-selected'

/** Destructive intent always keeps a text label in the calling component. */
export const DANGER = BUTTON_BASE
  + ' border-danger-line bg-surface text-danger-ink hover:bg-danger-surface active:bg-danger-hover'

export const GHOST = BUTTON_BASE
  + ' border-transparent bg-transparent text-ink-secondary hover:bg-surface-hover hover:text-ink active:bg-surface-selected'
export const ICON_BUTTON = GHOST.replace('px-3', 'px-1') + ' ui-icon-button min-w-control'

/** Row titles share the column's text edge without a toolbar button's inset. */
export const TABLE_ACTION =
  'inline-flex min-h-control items-center rounded-control text-left text-label font-medium text-ink '
  + 'hover:underline hover:underline-offset-2 focus-visible:outline-2 '
  + 'focus-visible:outline-offset-2 focus-visible:outline-focus'

/** Explicit compact variants replace brittle class-string substitutions. */
export const QUIET_COMPACT = QUIET.replace('px-3', 'px-2').replace('text-body', 'text-metadata')
export const DANGER_COMPACT = DANGER.replace('px-3', 'px-2').replace('text-body', 'text-metadata')

/** Page title/context on the left; actions on the right, wrapping when needed. */
export const PAGE_HEADER = 'ui-page-header flex flex-wrap items-center justify-between gap-3'

/** Compact navigation/export tools. ToolAction supplies the accessible name. */
export const TOOL_BUTTON =
  'ui-tool relative inline-flex min-h-control min-w-control items-center justify-center gap-1 rounded-control '
  + 'border border-line bg-surface px-1 text-ink-secondary hover:bg-surface-hover hover:text-ink '
  + 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus print:hidden'

/** Print has no added gutter and retains the original tree indentation. */
export function tableIndent(depth: number, step: number) {
  return { paddingLeft: `calc(var(--table-edge-gutter, 0px) + ${depth * step}rem)` }
}

/** Textareas retain their native rows instead of receiving a fixed height. */
export const FIELD =
  'ui-field min-h-control rounded-control border border-line bg-control px-2 py-1 text-body font-normal text-ink '
  + 'transition-colors placeholder:text-ink-muted focus:border-focus focus:outline-2 '
  + 'focus:outline-offset-2 focus:outline-focus disabled:cursor-not-allowed '
  + 'disabled:bg-surface-secondary disabled:text-ink-disabled'

export const FIELD_COMPACT = FIELD.replace('text-body', 'text-metadata')

/** Required labels are emphasized from the control's required attribute. */
export const LABEL = 'ui-label block text-label font-medium text-ink-secondary'
export const LABEL_COMPACT = LABEL.replace('text-label', 'text-caption')

/** Use panels for independent content units; layout alone groups form fields. */
export const SECTION = 'ui-section min-w-0'

export const CARD = 'ui-card rounded-panel border border-line-subtle bg-surface p-5'

/** Margins belong to the caller. Errors retain text and accessible alert roles. */
export const REFUSAL =
  'ui-refusal rounded-control border border-danger-line bg-danger-surface px-3 py-2 text-body text-danger-ink'

export const REFUSAL_QUIET =
  'ui-refusal rounded-control bg-danger-surface px-2 py-1 text-metadata text-danger-ink'

export const SUCCESS =
  'rounded-control border border-success-line bg-success-surface px-3 py-2 text-body text-success-ink'

/** One border utility rather than competing default and error utilities. */
export const FIELD_ALERT = FIELD.replace('border-line', 'border-danger-line')
