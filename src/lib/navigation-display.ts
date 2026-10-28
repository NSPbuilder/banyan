'use client'

import { useSyncExternalStore } from 'react'

const KEY = 'erp.nav.collapsed.v1'
const CHANGE = 'erp-nav-change'
let memoryValue = false
let storageUnavailable = false

function snapshot() {
  if (storageUnavailable) return memoryValue
  try { return localStorage.getItem(KEY) === 'true' } catch { return memoryValue }
}

function subscribe(notify: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY || event.key === null) notify()
  }
  window.addEventListener('storage', onStorage)
  window.addEventListener(CHANGE, notify)
  return () => {
    window.removeEventListener('storage', onStorage)
    window.removeEventListener(CHANGE, notify)
  }
}

const serverSnapshot = () => false

/** The Desk and every mounted ledger frame read the same display preference.
 * Storage events update the other documents; CHANGE updates this document. */
export function useNavigationCollapsed() {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot)
}

export function setNavigationCollapsed(value: boolean) {
  memoryValue = value
  try {
    localStorage.setItem(KEY, String(value))
    storageUnavailable = false
  } catch { storageUnavailable = true }
  window.dispatchEvent(new Event(CHANGE))
}
