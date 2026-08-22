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
  return isNew ? (obj as PosByStyle) : { [style]: obj as PosMap }
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
