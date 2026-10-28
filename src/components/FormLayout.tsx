import type { ReactNode } from 'react'

/** Compact working forms: controls keep useful widths instead of stretching. */
export const FORM_FIELD = 'w-field max-w-full min-w-0'
export const FORM_FIELD_SHORT = 'w-field-short max-w-full min-w-0'
export const FORM_FIELD_WIDE = 'w-field-wide max-w-full min-w-0'
export const FORM_FIELD_FULL = 'w-full min-w-0'
export function FormFields({ children, className = '' }: {children: ReactNode; className?: string}) {
  return <div className={`flex flex-wrap items-start gap-x-4 gap-y-3 ${className}`}>{children}</div>
}

export function FormSection({ title, description, children, className = '' }: {
  title: string; description?: ReactNode; children: ReactNode; className?: string
}) {
  return <fieldset className={`ui-form-section min-w-0 ${className}`}>
    <legend className="text-section-title font-semibold">{title}</legend>
    {description && <p className="mt-1 text-metadata text-ink-muted">{description}</p>}
    <div className="form-grid mt-3">{children}</div>
  </fieldset>
}

export function FilterBar({ children, actions, className = '' }: {
  children: ReactNode; actions?: ReactNode; className?: string
}) {
  return <div className={`ui-filter-bar flex flex-wrap items-end gap-3 print:hidden ${className}`}>
    <div className="flex min-w-0 flex-1 flex-wrap items-end gap-3">{children}</div>
    {actions && <div className="flex flex-none items-center gap-2">{actions}</div>}
  </div>
}
