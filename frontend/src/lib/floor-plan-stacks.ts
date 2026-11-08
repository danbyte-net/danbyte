import type { FloorPlanFloor } from "@/lib/api"

// A floor plan (stack) opens on the floor this browser last viewed in it, or
// on its first floor. Per browser only - storage may be missing or throw
// (private window, blocked site data), and then it is the first floor.

const key = (stackId: string) => `floorplan:last-floor:${stackId}`

/** Remember ``floorId`` as the floor last viewed in ``stackId``. */
export function rememberFloor(stackId: string, floorId: string) {
  try {
    window.localStorage.setItem(key(stackId), floorId)
  } catch {
    // No storage: the stack opens on its first floor.
  }
}

function lastFloor(stackId: string): string | null {
  try {
    return window.localStorage.getItem(key(stackId))
  } catch {
    return null
  }
}

/** The floor a stack opens on: the last viewed one while it is still a floor
 * of the stack, else the first (lowest) floor; null with no floors. */
export function entryFloor(stack: {
  id: string
  floors: Pick<FloorPlanFloor, "id">[]
}): string | null {
  const last = lastFloor(stack.id)
  if (last && stack.floors.some((f) => f.id === last)) return last
  return stack.floors[0]?.id ?? null
}
