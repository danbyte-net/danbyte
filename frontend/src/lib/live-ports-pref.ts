import { useSyncExternalStore } from "react"

/** Whether THIS viewer wants the live ports drawn on a rack's elevation and
 * a cabinet's plate: the ports coloured by state, their hover cards, a press
 * to trace, and each device's ports in use. Off, Images shows the bare
 * photos and Render the type's plain drawing. A per-browser switch - the
 * Ports tick on both pages - kept like the port labels one. Default on. */
const KEY = "danbyte.livePorts.shown"
const listeners = new Set<() => void>()

function read(): boolean {
  try {
    return window.localStorage.getItem(KEY) !== "0"
  } catch {
    return true
  }
}

export function setLivePortsShown(on: boolean): void {
  try {
    window.localStorage.setItem(KEY, on ? "1" : "0")
  } catch {
    // Storage blocked - listeners still get the in-memory change below.
  }
  memo = on
  for (const l of listeners) l()
}

let memo: boolean | null = null
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

export function useLivePortsShown(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => true)
}
