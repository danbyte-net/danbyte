import { useSyncExternalStore } from "react"

/** Whether THIS viewer wants port labels drawn at all, on top of the
 * deployment's choice: a per-browser switch (the 3D View menu, the device
 * page's Panel header) so a screen can be cleared of labels without an
 * admin touching the setting. Default on. */
const KEY = "danbyte.portLabels.shown"
const listeners = new Set<() => void>()

function read(): boolean {
  try {
    return window.localStorage.getItem(KEY) !== "0"
  } catch {
    return true
  }
}

export function setPortLabelsShown(on: boolean): void {
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

export function usePortLabelsShown(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => true)
}
