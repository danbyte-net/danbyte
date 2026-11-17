import { useSyncExternalStore } from "react"

/**
 * How THIS viewer wants the parts seated in ports drawn - transceivers,
 * cords and plugs (the "Pluggables", docs/dcim/model-packs.md): Show
 * (default), Ghost (see-through, so the port overlay reads through them)
 * or Hide (the bare faceplate; cable runs start at the port). A
 * per-browser choice shared by the device viewer, the rack's 3D view and
 * the 3D room, kept like the port labels one.
 */
export const PLUGGABLES_MODES = ["show", "ghost", "hide"] as const
export type PluggablesMode = (typeof PLUGGABLES_MODES)[number]

export const PLUGGABLES_LABEL: Record<PluggablesMode, string> = {
  show: "Show",
  ghost: "Ghost",
  hide: "Hide",
}

const KEY = "danbyte.pluggables.mode"
const listeners = new Set<() => void>()

/** A stored value as a mode; anything else is Show. */
export function readPluggablesMode(v: unknown): PluggablesMode {
  return PLUGGABLES_MODES.includes(v as PluggablesMode)
    ? (v as PluggablesMode)
    : "show"
}

/**
 * What a view draws: the viewer's choice, except that a port overlay
 * that is on (the device viewer's Ports) ghosts the parts for as long as
 * it is on - unless they are hidden.
 */
export function effectivePluggables(
  pref: PluggablesMode,
  overlayOn: boolean
): PluggablesMode {
  if (pref === "hide") return "hide"
  return overlayOn ? "ghost" : pref
}

function read(): PluggablesMode {
  try {
    return readPluggablesMode(window.localStorage.getItem(KEY))
  } catch {
    return "show"
  }
}

let memo: PluggablesMode | null = null
function snapshot(): PluggablesMode {
  if (memo == null) memo = read()
  return memo
}

export function setPluggablesMode(mode: PluggablesMode): void {
  try {
    window.localStorage.setItem(KEY, mode)
  } catch {
    // Storage blocked - listeners still get the in-memory change below.
  }
  memo = mode
  for (const l of listeners) l()
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

export function usePluggablesMode(): PluggablesMode {
  return useSyncExternalStore(subscribe, snapshot, () => "show")
}
