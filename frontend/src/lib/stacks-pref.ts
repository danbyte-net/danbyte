import { useSyncExternalStore } from "react"

/**
 * How THIS viewer wants switch stacks' cables drawn in 3D (the "Stacks"
 * choice, docs/dcim/virtual-chassis.md → In 3D): Show (default), Ghost
 * (see-through, as ghosted pluggables) or Hide (no stack cables; the
 * covers come back on the ports of a derived ring). A per-browser choice
 * shared by the rack's 3D view and the 3D room, kept like the Pluggables
 * one.
 */
export const STACKS_MODES = ["show", "ghost", "hide"] as const
export type StacksMode = (typeof STACKS_MODES)[number]

export const STACKS_LABEL: Record<StacksMode, string> = {
  show: "Show",
  ghost: "Ghost",
  hide: "Hide",
}

export const STACKS_KEY = "danbyte.stacks.mode"
const listeners = new Set<() => void>()

/** A stored value as a mode; anything else is Show. */
export function readStacksMode(v: unknown): StacksMode {
  return STACKS_MODES.includes(v as StacksMode) ? (v as StacksMode) : "show"
}

function read(): StacksMode {
  try {
    return readStacksMode(window.localStorage.getItem(STACKS_KEY))
  } catch {
    return "show"
  }
}

let memo: StacksMode | null = null
function snapshot(): StacksMode {
  if (memo == null) memo = read()
  return memo
}

export function setStacksMode(mode: StacksMode): void {
  try {
    window.localStorage.setItem(STACKS_KEY, mode)
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

export function useStacksMode(): StacksMode {
  return useSyncExternalStore(subscribe, snapshot, () => "show")
}
