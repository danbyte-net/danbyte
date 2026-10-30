import type { FloorPlanTile } from "@/lib/api"

/** A tile's link the reader may view - with its id. */
export type ShownLink = NonNullable<FloorPlanTile["linked"]> & { id: string }

/** The tile's link when the reader may view its object; null for no link
 * and for a Hidden one (another site's object - nothing to open, place or
 * look up). */
export function shownLink(
  linked: FloorPlanTile["linked"] | undefined
): ShownLink | null {
  return linked && !linked.hidden && linked.id ? (linked as ShownLink) : null
}
