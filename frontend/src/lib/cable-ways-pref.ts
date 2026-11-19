import { useSyncExternalStore } from "react"

/**
 * How THIS viewer wants cable ways drawn in 3D (the "Cable ways" choice,
 * docs/dcim/racks.md → Cable ways → In 3D): Show (default) draws each
 * cable along its way through the rack's managers, Ghost draws them
 * see-through with the managers and entries still solid, Hide draws none
 * (the room's runs then go port to port as before). "Fill" colours the
 * managers by how full they are (indicative). Per-browser choices shared
 * by the rack's 3D view and the 3D room, kept like the Stacks one.
 */
export const CABLE_WAYS_MODES = ["show", "ghost", "hide"] as const
export type CableWaysMode = (typeof CABLE_WAYS_MODES)[number]

export const CABLE_WAYS_LABEL: Record<CableWaysMode, string> = {
  show: "Show",
  ghost: "Ghost",
  hide: "Hide",
}

export const CABLE_WAYS_KEY = "danbyte.cable-ways.mode"
export const CABLE_WAYS_FILL_KEY = "danbyte.cable-ways.fill"

/** A stored value as a mode; anything else is Show. */
export function readCableWaysMode(v: unknown): CableWaysMode {
  return CABLE_WAYS_MODES.includes(v as CableWaysMode)
    ? (v as CableWaysMode)
    : "show"
}

function stored(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function store(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Storage blocked - listeners still get the in-memory change.
  }
}

const listeners = new Set<() => void>()
let mode: CableWaysMode | null = null
let fill: boolean | null = null

function subscribe(l: () => void) {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

function modeSnapshot(): CableWaysMode {
  if (mode == null) mode = readCableWaysMode(stored(CABLE_WAYS_KEY))
  return mode
}

function fillSnapshot(): boolean {
  if (fill == null) fill = stored(CABLE_WAYS_FILL_KEY) === "on"
  return fill
}

export function setCableWaysMode(next: CableWaysMode): void {
  store(CABLE_WAYS_KEY, next)
  mode = next
  for (const l of listeners) l()
}

export function setCableWaysFill(next: boolean): void {
  store(CABLE_WAYS_FILL_KEY, next ? "on" : "off")
  fill = next
  for (const l of listeners) l()
}

export function useCableWaysMode(): CableWaysMode {
  return useSyncExternalStore(subscribe, modeSnapshot, () => "show")
}

/** The Fill overlay: off by default. */
export function useCableWaysFill(): boolean {
  return useSyncExternalStore(subscribe, fillSnapshot, () => false)
}
