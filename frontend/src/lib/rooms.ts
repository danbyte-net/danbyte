import type { QueryClient } from "@tanstack/react-query"

/** Everything that shows a room or a room count goes stale with a room
 * write: the lists, the pickers, a location's Rooms tab and counts. */
export function invalidateRoomViews(qc: QueryClient): void {
  for (const key of [
    ["rooms"],
    ["room"],
    ["rooms-picker"],
    ["embedded-rooms"],
    ["location"],
    ["locations"],
  ])
    qc.invalidateQueries({ queryKey: key })
}
