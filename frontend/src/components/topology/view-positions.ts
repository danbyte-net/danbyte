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
export const POSITION_STYLES: NodeStyle[] = ["stencil", "hierarchy", "flat"]

/** Old stores held one flat map for every style; read it as the style it was
 * most likely arranged in, so nobody loses an arrangement to the split. */
export function migratePositions(raw: unknown, style: NodeStyle): PosByStyle {
  if (!raw || typeof raw !== "object") return {}
  const obj = raw as Record<string, unknown>
  const isNew = POSITION_STYLES.some((k) => k in obj)
  if (isNew) return obj as PosByStyle
  // Logical owns no arrangement: stamping a legacy map under "logical" made
  // every later Save-as POST a 400 for anyone who last used that tab.
  if (!POSITION_STYLES.includes(style)) return {}
  return { [style]: obj as PosMap }
}

/** A saved view's arrangements. Views written before the split carry one map
 * under `positions`; it belongs to the style the view was saved in. */
export function viewPositions(
  v: TopologyViewSaved,
  styleOf: (raw: unknown) => string
): PosByStyle {
  const byStyle = v.state.positions_by_style as PosByStyle | undefined
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
  /** One of ZONE_COLORS; anything else falls back to the first. */
  color: string
}

export type ZonesByStyle = Partial<Record<NodeStyle, Zone[]>>

/** The zone palette - a tint each, meaning nothing on its own. Kept small
 * on purpose: a colour picker here invites a rainbow nobody can read. */
export const ZONE_COLORS = [
  "#64748b",
  "#0ea5e9",
  "#10b981",
  "#f59e0b",
  "#ec4899",
  "#8b5cf6",
] as const

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
