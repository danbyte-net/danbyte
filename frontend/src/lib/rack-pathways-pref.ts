import { useSyncExternalStore } from "react"

/** Whether THIS viewer wants a rack's pathways drawn on its 2D elevation
 * (docs/dcim/racks.md → Pathways → On the elevation): its vertical managers
 * and channels beside the rails, its horizontal managers in their units and
 * its roof and floor entries, to click and edit. A per-browser switch - the
 * Pathways tick in the elevation's Display menu - kept like the Ports one.
 * Default off, so the plain elevation is unchanged. */
const KEY = "danbyte.rackPathways.shown"
const listeners = new Set<() => void>()

function read(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "1"
  } catch {
    return false
  }
}

let memo: boolean | null = null

export function setRackPathwaysShown(on: boolean): void {
  try {
    window.localStorage.setItem(KEY, on ? "1" : "0")
  } catch {
    // Storage blocked - listeners still get the in-memory change below.
  }
  memo = on
  for (const l of listeners) l()
}

function snapshot(): boolean {
  if (memo == null) memo = read()
  return memo
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

export function useRackPathwaysShown(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false)
}
