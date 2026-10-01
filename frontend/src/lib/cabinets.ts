import type { QueryClient } from "@tanstack/react-query"

import type { CabinetSizes } from "@/lib/api"

// How a cabinet's (or cabinet type's) sizes read wherever they are shown -
// the list columns, the detail pages and the embedded tables all format
// through here, so "600×700×210 mm" is spelled one way.

/** "525×650 mm" - the mounting plate the rails are fixed to. */
export function plateSize(
  s: Pick<CabinetSizes, "inner_width_mm" | "inner_height_mm">
): string {
  return `${s.inner_width_mm}×${s.inner_height_mm} mm`
}

/** "600×700×210 mm" - the box, width × height × depth. Depth is left off
 * when unknown; null while the width or height is. */
export function outerSize(
  s: Pick<CabinetSizes, "outer_width_mm" | "outer_height_mm" | "outer_depth_mm">
): string | null {
  if (s.outer_width_mm == null || s.outer_height_mm == null) return null
  const depth = s.outer_depth_mm != null ? `×${s.outer_depth_mm}` : ""
  return `${s.outer_width_mm}×${s.outer_height_mm}${depth} mm`
}

/** "Rittal AE 1060.500" - a type reads with its maker, as on the form. */
export function cabinetTypeLabel(t: {
  name: string
  manufacturer: { name: string } | null
}): string {
  return t.manufacturer ? `${t.manufacturer.name} ${t.name}` : t.name
}

/** Every cached view a cabinet write changes: the lists, pickers and embedded
 * panes that show cabinets, and the type and role pages whose counts it adds
 * to. `["cabinet-types"]` does not prefix-match `["cabinet-type", id]`, hence
 * both. */
export const CABINET_VIEW_KEYS: string[][] = [
  ["cabinets"],
  ["cabinets-picker"],
  ["embedded-cabinets"],
  ["cabinet-types"],
  ["cabinet-type"],
  ["cabinet-roles"],
  ["cabinet-role"],
]

/** Refetch every cabinet view after a cabinet is created, edited or deleted. */
export function invalidateCabinetViews(qc: QueryClient) {
  for (const queryKey of CABINET_VIEW_KEYS)
    void qc.invalidateQueries({ queryKey })
}
