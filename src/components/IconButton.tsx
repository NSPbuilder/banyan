import type { ButtonHTMLAttributes } from 'react'
import { ICON_BUTTON } from '@/lib/ui'
import { Icon } from './Icon'

/** Label also supplies the tooltip; decorative SVGs never carry the name. */
export function IconButton({ label, icon, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string
  icon: string
}) {
  return <button type="button" {...props} aria-label={label} title={label} className={`${ICON_BUTTON} ${className}`}><Icon name={icon} /></button>
}
