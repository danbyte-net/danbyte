import type { TopologyViewSaved } from "@/lib/api"
import type { NodeStyle } from "@/components/topology/topology-canvas"

/**
 * Node arrangements, held **per view style**.
 *
 * The node ids are the same in every style (`dev:<uuid>`), but the cards are
 * not: a Wiring stencil sized to its ports, a Hierarchy card as tall as its
 * port list and a Flat chip need completely different coordinates. While one
 * shared map served all three, arranging Flat silently overwrote the
 * Hierarchy arrangement - and then handed Hierarchy's much larger cards the
 * spacing that was tuned for chips.
 */
export type PosMap = Record<string, [number, number]>
export type PosByStyle = Partial<Record<NodeStyle, PosMap>>

/** The styles that own an arrangement (Logical is a rail diagram, not a
 * canvas, so it has none). Mirrors the backend's validation list. */
export const POSITION_STYLES: NodeStyle[] = [
  "stencil",
  "hierarchy",
  "flat",
  "diagram",
]

/** Old stores held one flat map for every style; read it as the style it was
 * most likely arranged in, so nobody loses an arrangement to the split. */
export function migratePositions(raw: unknown, style: NodeStyle): PosByStyle {
  if (!raw || typeof raw !== "object") return {}
  const obj = raw as Record<string, unknown>
  const isNew = POSITION_STYLES.some((k) => k in obj)
  if (isNew) return obj
  // Logical owns no arrangement: stamping a legacy map under "logical" made
  // every later Save-as POST a 400 for anyone who last used that tab.
  if (!POSITION_STYLES.includes(style)) return {}
  return { [style]: obj as PosMap }
}

/** A saved view's arrangements. Views written before the split carry one map
 * under `positions`; it belongs to the style the view was saved in. */
export function viewPositions(
  v: Pick<TopologyViewSaved, "state">,
  styleOf: (raw: unknown) => string
): PosByStyle {
  const byStyle = v.state.positions_by_style
  if (byStyle && typeof byStyle === "object") return byStyle
  const style = styleOf(
    (v.state.filters as { viewStyle?: unknown } | undefined)?.viewStyle
  )
  return v.state.positions && POSITION_STYLES.includes(style as NodeStyle)
    ? { [style as NodeStyle]: v.state.positions }
    : {}
}

/**
 * A zone: a labelled box drawn behind the map to group things by eye.
 *
 * Annotation only - it does not own the cards inside it, so dragging a zone
 * moves the box and nothing else. That is what makes it safe to draw one
 * across a map somebody else arranged.
 *
 * On the Diagram tab the same list also holds **bands** (`kind: "band"`,
 * see diagram/bands.ts): a row (`orient: "h"`) groups the cards whose
 * centre is inside it and carries them when it moves; a side band
 * (`orient: "v"`) is a labelled strip beside the rows.
 *
 * Held per view style for the same reason positions are: a box that frames
 * four Flat chips frames half a card in Stencil.
 */
export interface Zone {
  id: string
  label: string
  x: number
  y: number
  w: number
  h: number
  /** A #rrggbb colour - one of ZONE_COLORS or of Danbyte's presets
   * (ui/color-picker.tsx); anything else falls back to the first swatch. A
   * band may be neutral: null or "". */
  color: string | null
  /** Absent = "zone" (every view saved before bands). */
  kind?: "zone" | "band"
  /** Bands: a row (`h`, the default) or a side band (`v`). */
  orient?: "h" | "v"
  /** A band made by Arrange: what it was generated from, so a re-run finds
   * it again (and keeps its name and colour). */
  rule?: { by: "role" | "device_type"; ids: string[] }
  /** A row holding several layers (roles or types): a sub-row per layer
   * under its title (`stack`), or all its cards in one row (`row`). Set
   * once the band's layers were chosen by hand - Arrange keeps such a
   * band as it is. Absent: a row. */
  layout?: "stack" | "row"
  /** A row: the sides its cards' cables to other bands leave by - top and
   * bottom (`v`) or left and right (`h`). Absent: whichever faces the far
   * end (Auto). */
  exits?: BandExits
}

/** Which sides a row's cables to other bands leave by: top and bottom, or
 * left and right. */
export type BandExits = "v" | "h"

export type ZonesByStyle = Partial<Record<NodeStyle, Zone[]>>

/** The zone and band quick swatches - a tint each, meaning nothing on its
 * own. Danbyte's full preset grid sits behind them (More colors). */
export const ZONE_COLORS = [
  "#64748b",
  "#0ea5e9",
  "#10b981",
  "#f59e0b",
  "#ec4899",
  "#8b5cf6",
] as const

/** A region colour worth drawing: a #rrggbb hex. */
export const isZoneColor = (c: unknown): c is string =>
  typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c)

export const ZONE_W = 420
export const ZONE_H = 260

/** A saved view's zones, tolerating a view written before zones existed. */
export function viewZones(raw: unknown): ZonesByStyle {
  if (!raw || typeof raw !== "object") return {}
  const out: ZonesByStyle = {}
  for (const style of POSITION_STYLES) {
    const list = (raw as Record<string, unknown>)[style]
    if (Array.isArray(list)) out[style] = list
  }
  return out
}
