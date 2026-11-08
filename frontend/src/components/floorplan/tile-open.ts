import type { FloorPlanLinkKind, FloorPlanTile } from "@/lib/api"

import { shownLink } from "./shown-link"

/** How a tile linked to each kind opens on the plan: a nested plan
 * navigates, devices, racks and cabinets open the detail panel, and every
 * other kind - power panels, feeds, cooling sources - pins the tile's
 * popover, which names the object, carries its figures and links to its
 * page. A Record so a new link kind cannot be left without a way in. */
export const LINK_OPENS: Record<
  FloorPlanLinkKind,
  "plan" | "panel" | "popover"
> = {
  floorplan: "plan",
  rack: "panel",
  cabinet: "panel",
  device: "panel",
  powerpanel: "popover",
  powerfeed: "popover",
  coolingsource: "popover",
}

/** Each link kind's name: one (the pointer menu's "Open …") and many (an
 * Objects list group of untyped tiles). */
export const LINK_KIND_NAME: Record<
  FloorPlanLinkKind,
  { one: string; many: string }
> = {
  floorplan: { one: "plan", many: "Floor plans" },
  rack: { one: "rack", many: "Racks" },
  cabinet: { one: "cabinet", many: "Cabinets" },
  device: { one: "device", many: "Devices" },
  powerpanel: { one: "power panel", many: "Power panels" },
  powerfeed: { one: "power feed", many: "Power feeds" },
  coolingsource: { one: "cooling source", many: "Cooling sources" },
}

export type TileOpen =
  { kind: "plan"; id: string } | { kind: "panel" } | { kind: "popover" }

/** What opening this tile does. An unlinked tile, a link to an unknown kind
 * and a Hidden link (another site's object) open its popover: it selects
 * and shows what the plan knows, never nothing. */
export function tileOpen(tile: FloorPlanTile): TileOpen {
  const l = shownLink(tile.linked)
  const how = l ? LINK_OPENS[l.kind] : undefined
  if (l && how === "plan") return { kind: "plan", id: l.id }
  if (how === "panel") return { kind: "panel" }
  return { kind: "popover" }
}
