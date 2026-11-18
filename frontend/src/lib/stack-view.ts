import { useSyncExternalStore } from "react"

/**
 * The device page's stack view (docs/dcim/virtual-chassis.md → On the
 * device page): a stack member's 3D card draws every member the reader may
 * view, stacked, with the stack cables between them. Here are the pure
 * parts - where each member stands, and the per-browser Stack toggle - so
 * they test without a canvas.
 */

/** One rack unit (m). */
export const STACK_U_M = 0.04445

/** A member as the layout reads it. */
export interface StackViewMember {
  device: string
  /** Its member number. */
  position: number
  /** The rack it is in, when it has a U position in one. */
  rack: { id: string; desc_units?: boolean } | null
  /** Its lowest U in that rack (the rack's numbering), or null. */
  u: number | null
  /** Its height in U (a 0U device counts as 1U). */
  uHeight: number
}

/**
 * Where each member's bottom stands (m above the lowest one), by device id:
 *
 * - the members in the **same rack** as the current device (or, when it
 *   has no U position, the rack holding the most members) keep their real
 *   relative U positions, gaps included - a descending rack read the
 *   right way up;
 * - every other member is stacked below them in member order, the lowest
 *   number on top, each **1U** below the one above.
 *
 * A member with no U height counts as 1U. The same members give the same
 * layout.
 */
export function stackLayout(
  members: readonly StackViewMember[],
  currentId: string
): Map<string, number> {
  const racked = (m: StackViewMember) => m.rack !== null && m.u !== null
  const height = (m: StackViewMember) => Math.max(1, m.uHeight || 1)
  const current = members.find((m) => m.device === currentId)
  let rackId: string | null =
    current && racked(current) ? current.rack!.id : null
  if (rackId === null) {
    const count = new Map<string, number>()
    for (const m of members)
      if (racked(m)) count.set(m.rack!.id, (count.get(m.rack!.id) ?? 0) + 1)
    let best = 1
    for (const m of [...members].sort((x, y) => x.position - y.position)) {
      const n = racked(m) ? (count.get(m.rack!.id) ?? 0) : 0
      if (n > best) {
        best = n
        rackId = m.rack!.id
      }
    }
  }
  // The rack's members in U from its floor: an ascending rack's lowest U
  // is the bottom; a descending one counts down, so its bottom is the
  // highest-numbered unit the device takes.
  const inRack = members.filter((m) => racked(m) && m.rack!.id === rackId)
  const bottomU = (m: StackViewMember) =>
    m.rack!.desc_units ? -(m.u! + height(m) - 1) : m.u!
  const out = new Map<string, number>()
  const lowest = inRack.length ? Math.min(...inRack.map(bottomU)) : 0
  for (const m of inRack) out.set(m.device, (bottomU(m) - lowest) * STACK_U_M)
  // The rest: below, in member order, top down, a 1U gap between each.
  const rest = members
    .filter((m) => !out.has(m.device))
    .sort((x, y) => x.position - y.position)
  let top = inRack.length ? -STACK_U_M : 0
  for (const m of rest) {
    const bottom = top - height(m) * STACK_U_M
    out.set(m.device, bottom)
    top = bottom - STACK_U_M
  }
  // Stand the lowest on the floor.
  const floor = Math.min(0, ...out.values())
  if (floor !== 0) for (const [k, v] of out) out.set(k, v - floor)
  return out
}

// ── the Stack toggle ─────────────────────────────────────────────────────

/** Whether THIS viewer wants a stack member's 3D card to draw the whole
 * stack: a per-browser choice, default off, kept like Pluggables. */
export const STACK_VIEW_KEY = "danbyte.stackView.on"
const listeners = new Set<() => void>()

function read(): boolean {
  try {
    return window.localStorage.getItem(STACK_VIEW_KEY) === "1"
  } catch {
    return false
  }
}

let memo: boolean | null = null
function snapshot(): boolean {
  if (memo == null) memo = read()
  return memo
}

export function setStackViewOn(on: boolean): void {
  try {
    window.localStorage.setItem(STACK_VIEW_KEY, on ? "1" : "0")
  } catch {
    // Storage blocked - listeners still get the in-memory change below.
  }
  memo = on
  for (const l of listeners) l()
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

export function useStackViewOn(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false)
}
