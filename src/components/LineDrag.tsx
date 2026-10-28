'use client'

import { useEffect, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes } from 'react'
import { IconButton } from './IconButton'

type Drag = {
  key: string; from: number; to: number; button: HTMLButtonElement
  pointerId?: number; startX: number; startY: number; x: number; y: number
  active: boolean; scrollParents: HTMLElement[]; ghost?: HTMLElement; indicator?: HTMLElement; left: number; offsetY: number
}
type Display = { key: string; to: number } | null

export function useLineDrag({ keys, disabled = false, onReorder }: {
  keys: string[]; disabled?: boolean; onReorder: (key: string, to: number) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const helpId = useId()
  const latest = useRef({ keys, disabled, onReorder })
  useLayoutEffect(() => { latest.current = { keys, disabled, onReorder } })
  const session = useRef<Drag | null>(null)
  const frame = useRef<number | null>(null)
  const [display, setDisplay] = useState<Display>(null)
  const [message, setMessage] = useState('')

  const stop = () => {
    const drag = session.current
    session.current = null
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = null
    drag?.ghost?.remove()
    drag?.indicator?.remove()
    if (drag?.pointerId !== undefined && drag.button.hasPointerCapture(drag.pointerId)) drag.button.releasePointerCapture(drag.pointerId)
    setDisplay(null)
    return drag
  }
  const cancel = () => {
    const drag = stop()
    if (drag?.active) setMessage('Reordering cancelled.')
  }
  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    session.current?.ghost?.remove()
    session.current?.indicator?.remove()
    session.current = null
  }, [])
  const keySignature = JSON.stringify(keys)
  useEffect(() => {
    // A pending save or an external row change cannot commit a stale drag.
    if (session.current) cancel()
    // cancel intentionally uses refs, not the current render's display state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled, keySignature])

  const rows = () => [...(containerRef.current?.querySelectorAll<HTMLElement>('[data-sort-row]') ?? [])]
  const targetAt = (drag: Drag) => {
    const remaining = rows().filter(row => row.dataset.sortRow !== drag.key)
    const index = remaining.findIndex(row => {
      const box = row.getBoundingClientRect()
      return drag.y < box.top + box.height / 2
    })
    return index < 0 ? remaining.length : index
  }
  const updateDisplay = (drag: Drag) => {
    setDisplay(old => old?.key === drag.key && old.to === drag.to ? old : { key: drag.key, to: drag.to })
  }
  const makeGhost = (drag: Drag) => {
    const source = rows().find(row => row.dataset.sortRow === drag.key)
    if (!source) return
    const box = source.getBoundingClientRect()
    const cells = [...source.children].map(cell => cell.getBoundingClientRect().width)
    const copy = source.cloneNode(true) as HTMLElement
    for (const name of ['data-sort-row', 'data-line-row', 'data-line', 'data-sort-dragging', 'data-sort-before', 'data-sort-after']) copy.removeAttribute(name)
    copy.querySelectorAll('[popover], [role="listbox"]').forEach(el => el.remove())
    for (const el of [copy, ...copy.querySelectorAll<HTMLElement>('*')]) {
      el.removeAttribute('id'); el.removeAttribute('name'); el.removeAttribute('form')
    }
    const originals = [...source.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input,select,textarea')]
      .filter(el => !el.closest('[popover], [role="listbox"]'))
    copy.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input,select,textarea').forEach((el, i) => { el.value = originals[i]?.value ?? '' })
    const ghost = document.createElement('div')
    ghost.className = 'line-drag-ghost'
    ghost.setAttribute('aria-hidden', 'true'); ghost.inert = true
    ghost.style.width = `${box.width}px`
    if (source.tagName === 'TR') {
      const table = document.createElement('table'), body = document.createElement('tbody')
      table.className = source.closest('table')?.className ?? ''
      table.style.width = '100%'; table.style.minWidth = '0'; table.style.tableLayout = 'fixed'
      ;[...copy.children].forEach((cell, i) => { (cell as HTMLElement).style.width = `${cells[i]}px` })
      body.append(copy); table.append(body); ghost.append(table)
    } else ghost.append(copy)
    const indicator = document.createElement('div')
    indicator.className = 'line-drag-indicator'
    indicator.setAttribute('aria-hidden', 'true'); indicator.inert = true
    document.body.append(ghost, indicator)
    drag.ghost = ghost; drag.indicator = indicator; drag.left = box.left; drag.offsetY = drag.startY - box.top
  }
  const tick = () => {
    const drag = session.current
    if (!drag?.active || drag.pointerId === undefined) return
    // Read layout first, then update the preview and one scrolling ancestor.
    drag.to = targetAt(drag)
    const remaining = rows().filter(row => row.dataset.sortRow !== drag.key)
    const target = remaining[Math.min(drag.to, remaining.length - 1)]?.getBoundingClientRect()
    const insertionY = target && (drag.to === remaining.length ? target.bottom : target.top)
    let scroll: { element: HTMLElement; delta: number } | undefined
    for (const element of drag.scrollParents) {
      const viewport = element === document.scrollingElement
        ? { top: 0, bottom: innerHeight, left: 0, right: innerWidth }
        : element.getBoundingClientRect()
      if (drag.x < viewport.left || drag.x > viewport.right || drag.y < viewport.top - 40 || drag.y > viewport.bottom + 40) continue
      const delta = drag.y < viewport.top + 40 ? -Math.ceil((viewport.top + 40 - drag.y) / 3)
        : drag.y > viewport.bottom - 40 ? Math.ceil((drag.y - viewport.bottom + 40) / 3) : 0
      if (delta && (delta < 0 ? element.scrollTop > 0 : element.scrollTop + element.clientHeight < element.scrollHeight - 1)) {
        scroll = { element, delta: Math.max(-18, Math.min(18, delta)) }; break
      }
    }
    updateDisplay(drag)
    if (drag.ghost) {
      const transform = `translate(${drag.left}px, ${drag.y - drag.offsetY}px)`
      if (drag.ghost.style.transform !== transform) drag.ghost.style.transform = transform
    }
    if (drag.indicator && target && insertionY !== undefined) {
      const transform = `translate(${target.left}px, ${insertionY - 1}px)`, width = `${target.width}px`
      if (drag.indicator.style.transform !== transform) drag.indicator.style.transform = transform
      if (drag.indicator.style.width !== width) drag.indicator.style.width = width
    }
    if (scroll) scroll.element.scrollTop += scroll.delta
    frame.current = requestAnimationFrame(tick)
  }
  const commit = () => {
    const drag = stop()
    if (!drag?.active || latest.current.disabled || drag.button.closest('form')?.dataset.pending === 'true') return
    if (drag.from !== drag.to) latest.current.onReorder(drag.key, drag.to)
    setMessage(`Line ${drag.from + 1} moved to position ${drag.to + 1} of ${latest.current.keys.length}.`)
    requestAnimationFrame(() => { if (drag.button.isConnected) drag.button.focus({ preventScroll: true }) })
  }
  const start = (key: string, button: HTMLButtonElement, pointer?: { id: number; x: number; y: number }) => {
    if (latest.current.disabled || latest.current.keys.length < 2 || button.closest('form')?.dataset.pending === 'true') return
    const from = latest.current.keys.indexOf(key)
    if (from < 0) return
    const scrollParents: HTMLElement[] = []
    for (let el: HTMLElement | null = button.parentElement; el; el = el.parentElement) {
      if (el.scrollHeight > el.clientHeight && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) scrollParents.push(el)
    }
    const page = document.scrollingElement as HTMLElement | null
    if (page && !scrollParents.includes(page)) scrollParents.push(page)
    session.current = { key, from, to: from, button, pointerId: pointer?.id,
      startX: pointer?.x ?? 0, startY: pointer?.y ?? 0, x: pointer?.x ?? 0, y: pointer?.y ?? 0,
      active: !pointer, scrollParents, left: 0, offsetY: 0 }
    button.focus({ preventScroll: true })
    if (pointer) button.setPointerCapture(pointer.id)
    else {
      updateDisplay(session.current)
      setMessage(`Picked up line ${from + 1}. Use Up or Down to choose a position, then Space to drop.`)
    }
  }
  const handleProps = (key: string): ButtonHTMLAttributes<HTMLButtonElement> => ({
    disabled: disabled || keys.length < 2,
    'aria-describedby': helpId,
    'aria-pressed': display?.key === key,
    'aria-keyshortcuts': 'Space Enter ArrowUp ArrowDown Escape',
    onPointerDown: event => { if (event.button === 0 && !session.current) start(key, event.currentTarget, { id: event.pointerId, x: event.clientX, y: event.clientY }) },
    onPointerMove: event => {
      const drag = session.current
      if (!drag || drag.pointerId !== event.pointerId) return
      drag.x = event.clientX; drag.y = event.clientY
      if (!drag.active && Math.hypot(drag.x - drag.startX, drag.y - drag.startY) >= 4) {
        drag.active = true; makeGhost(drag); frame.current = requestAnimationFrame(tick)
      }
      if (drag.active) event.preventDefault()
    },
    onPointerUp: event => {
      const drag = session.current
      if (!drag || drag.pointerId !== event.pointerId) return
      drag.x = event.clientX; drag.y = event.clientY
      const box = containerRef.current?.getBoundingClientRect()
      if (drag.active && box && drag.x >= box.left && drag.x <= box.right) { drag.to = targetAt(drag); commit() }
      else cancel()
    },
    onPointerCancel: cancel,
    onLostPointerCapture: () => { if (session.current?.pointerId !== undefined) cancel() },
    onDragStart: event => event.preventDefault(),
    onBlur: () => { if (session.current?.pointerId === undefined) cancel() },
    onKeyDown: event => {
      if (event.key === 'Escape') { event.preventDefault(); cancel(); return }
      if (session.current?.pointerId !== undefined) return
      if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault()
        if (event.repeat) return
        if (session.current) commit(); else start(key, event.currentTarget)
      } else if (session.current && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        event.preventDefault()
        const drag = session.current
        drag.to = Math.max(0, Math.min(latest.current.keys.length - 1, drag.to + (event.key === 'ArrowUp' ? -1 : 1)))
        updateDisplay(drag)
        rows().filter(row => row.dataset.sortRow !== drag.key)[Math.min(drag.to, keys.length - 2)]?.scrollIntoView({ block: 'nearest' })
        setMessage(`Position ${drag.to + 1} of ${keys.length}.`)
      } else if (event.key === 'Tab') cancel()
    },
  })
  const remaining = display ? keys.filter(key => key !== display.key) : []
  const rowProps = (key: string) => ({
    'data-sort-row': key,
    'data-sort-dragging': display?.key === key ? 'true' : undefined,
    'data-sort-before': display && remaining[display.to] === key ? 'true' : undefined,
    'data-sort-after': display && display.to === remaining.length && remaining.at(-1) === key ? 'true' : undefined,
  })
  return { containerRef, helpId, message, handleProps, rowProps, isDragging: display !== null }
}

export type LineDragBindings = ReturnType<typeof useLineDrag>

export function LineDragHandle({ index, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { index: number }) {
  return <IconButton icon="grip" label={`Reorder line ${index + 1}`} {...props} className="line-drag-handle shrink-0 touch-none select-none" />
}

export function LineDragStatus({ id, message }: { id: string; message: string }) {
  return <><span id={id} className="sr-only">Drag the handle to reorder. Keyboard: Space or Enter to pick up; Up or Down to choose a position; Space or Enter to drop; Escape to cancel.</span>
    <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{message}</span></>
}
