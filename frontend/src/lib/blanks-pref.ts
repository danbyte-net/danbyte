import { useSyncExternalStore } from "react"

/**
 * Whether THIS viewer sees blanking panels in 3D (the "Blanks" toggle,
 * docs/dcim/racks.md → Blanking fill): on (the default) each rack shows
 * the fill its Look asks for; off hides the fill everywhere. A per-browser
 * choice shared by the rack's 3D view and the 3D room, kept like the
 * Stacks one.
 */
export const BLANKS_KEY = "danbyte.blanks.shown"
const listeners = new Set<() => void>()

/** A stored value as the choice; anything but "off" is on. */
export function readBlanksShown(v: unknown): boolean {
  return v !== "off"
}

function read(): boolean {
  try {
    return readBlanksShown(window.localStorage.getItem(BLANKS_KEY))
  } catch {
    return true
  }
}

let memo: boolean | null = null
function snapshot(): boolean {
  if (memo == null) memo = read()
  return memo
}

export function setBlanksShown(shown: boolean): void {
  try {
    window.localStorage.setItem(BLANKS_KEY, shown ? "on" : "off")
  } catch {
    // Storage blocked - listeners still get the in-memory change below.
  }
  memo = shown
  for (const l of listeners) l()
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

export function useBlanksShown(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => true)
}
