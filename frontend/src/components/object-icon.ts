import type { FloorPlanTile } from "@/lib/api"
import { isValidIconName } from "@/components/dynamic-icon"

// The icon an object draws with on a map or a floor plan. Nothing is
// seeded: a device, its type and its role each may name one, and where
// none does the object takes its kind's default here, in code.

/** The default icon by kind - the sidebar's own icons for the three. */
export const KIND_ICON: Readonly<Record<string, string>> = {
  device: "server",
  rack: "container",
  cabinet: "rows-4",
}

/** The first of `names` Lucide knows, else `fallback` ("" for none). A
 * stale or mistyped name falls through to the next. */
export function firstIcon(
  names: readonly (string | null | undefined)[],
  fallback = ""
): string {
  for (const n of names) {
    const name = (n ?? "").trim()
    if (name && isValidIconName(name)) return name
  }
  return fallback
}

/**
 * A floor tile's icon: the linked device's own, else its device type's
 * (`linked.icon`, resolved by the server), then the tile's own type, then
 * the role - the tile's role type or the object's role - and last the
 * default for its kind. A tile linked to nothing has no default.
 */
export function tileIcon(
  t: Pick<FloorPlanTile, "linked" | "tile_type" | "role_type">
): string {
  return firstIcon(
    [
      t.linked?.icon,
      t.tile_type?.icon,
      t.role_type?.icon,
      t.linked?.role?.icon,
    ],
    KIND_ICON[t.linked?.kind ?? ""] ?? ""
  )
}

/** A 3D scene tile's icon: the server resolved the order, the kind's
 * default fills the gap. */
export function sceneTileIcon(t: { icon?: string; kind: string }): string {
  return firstIcon([t.icon], KIND_ICON[t.kind] ?? "")
}
