'use client'

import { useId, useRef, useState, type ReactNode } from 'react'
import { ICON_BUTTON } from '@/lib/ui'
import { Icon } from './Icon'

/** Row actions use the native top layer so a scrolling table cannot clip them. */
export function ActionMenu({label='More actions',children}:{label?:string;children:ReactNode}) {
  const id=useId(),trigger=useRef<HTMLButtonElement>(null),[open,setOpen]=useState(false)
  return <>
    <button type="button" ref={trigger} popoverTarget={id} aria-label={label} title={label} aria-expanded={open} className={ICON_BUTTON}><Icon name="more"/></button>
    <div id={id} popover="auto" aria-label={label} role="group" className="fixed inset-auto m-0 rounded-panel border border-line bg-surface-elevated p-2 text-ink shadow-sm"
      onToggle={e=>{
        const panel=e.currentTarget,visible=panel.matches(':popover-open');setOpen(visible)
        if(!visible||!trigger.current)return
        const b=trigger.current.getBoundingClientRect(),p=panel.getBoundingClientRect(),w=window.innerWidth,h=window.innerHeight
        panel.style.left=Math.max(8,Math.min(b.right-p.width,w-p.width-8))+'px'
        panel.style.top=(b.bottom+p.height+8>h?Math.max(8,b.top-p.height-4):b.bottom+4)+'px'
        panel.querySelector<HTMLButtonElement>('button')?.focus()
      }}
      onClick={e=>{if(e.target instanceof Element&&e.target.closest('button,a')&&!e.target.closest('dialog'))e.currentTarget.hidePopover()}}>
      {children}
    </div>
  </>
}
