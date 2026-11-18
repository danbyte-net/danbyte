import { useSyncExternalStore } from "react"

/**
 * Which rack doors this viewer has clicked open (docs/dcim/racks.md →
 * Look). Per viewer and per page load: never saved, never shared. Kept
 * outside React so a rack that drops to a farther tier and comes back
 * finds its door as it left it.
 */
const open = new Set<string>()
const listeners = new Set<() => void>()
let version = 0

export type DoorSide = "front" | "rear"

export function doorKey(rackId: string, side: DoorSide, leaf = 0): string {
  return `${rackId}:${side}:${leaf}`
}

export function isDoorOpen(key: string): boolean {
  return open.has(key)
}

export function setDoorOpen(key: string, on: boolean) {
  if (open.has(key) === on) return
  if (on) open.add(key)
  else open.delete(key)
  version += 1
  listeners.forEach((fn) => fn())
}

export function toggleDoor(key: string) {
  setDoorOpen(key, !open.has(key))
}

/** Shut every door (tests; a scene that wants a clean start). */
export function shutAllDoors() {
  if (open.size === 0) return
  open.clear()
  version += 1
  listeners.forEach((fn) => fn())
}

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Whether the door `key` is open; re-renders when it flips. */
export function useDoorOpen(key: string): boolean {
  useSyncExternalStore(
    subscribe,
    () => version,
    () => version
  )
  return open.has(key)
}

/** The viewer asked the system for less motion: doors snap. */
export function reducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches
  } catch {
    return false
  }
}
