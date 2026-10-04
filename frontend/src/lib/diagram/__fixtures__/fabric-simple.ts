import { documentBounds } from "../geometry"
import type {
  DiagramDocument,
  DiagramEnd,
  DiagramLink,
  DiagramNode,
  Pt,
  Side,
} from "../types"
import { fabric } from "./fabric"

// The fabric in Simple mode, as a builder hands it to the draw.io writer by
// default: no nubs, every line on a side meeting at the side's midpoint,
// routes drawn for those ends, a LAG folded into one line, and end labels
// level a little way along the line instead of turned along it.

const NORMAL: Record<Side, Pt> = {
  top: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
}

const nodes: DiagramNode[] = fabric.nodes.map((n) => {
  const card = { ...n }
  delete card.nubs
  return card
})
const byId = new Map(nodes.map((n) => [n.id, n]))

/** The midpoint of the side an end leaves from. */
function atMid(end: DiagramEnd): DiagramEnd {
  const n = byId.get(end.node)
  if (!n) throw new Error(`no node ${end.node}`)
  const side = end.side ?? "top"
  const x = side === "left" ? n.x : side === "right" ? n.x + n.w : n.x + n.w / 2
  const y = side === "top" ? n.y : side === "bottom" ? n.y + n.h : n.y + n.h / 2
  return { node: n.id, x, y, side }
}

/** Interior points for a route between two side midpoints. */
function route(l: DiagramLink, s: DiagramEnd, t: DiagramEnd): Pt[] {
  if (l.kind === "elbow") {
    if (s.side === "top" || s.side === "bottom") {
      const y = (s.y + t.y) / 2
      return [
        { x: s.x, y },
        { x: t.x, y },
      ]
    }
    const x = (s.x + t.x) / 2
    return [
      { x, y: s.y },
      { x, y: t.y },
    ]
  }
  if (l.kind === "bendy") {
    const k = Math.min(
      160,
      Math.max(30, 0.4 * Math.hypot(t.x - s.x, t.y - s.y))
    )
    const [ns, nt] = [NORMAL[s.side ?? "top"], NORMAL[t.side ?? "top"]]
    return [
      { x: s.x + ns.x * k, y: s.y + ns.y * k },
      { x: t.x + nt.x * k, y: t.y + nt.y * k },
    ]
  }
  if (l.kind === "cyclical") {
    const y = l.points[0].y
    const dx = t.x - s.x
    return [
      { x: s.x + 0.15 * dx, y },
      { x: s.x + 0.85 * dx, y },
    ]
  }
  return []
}

const links: DiagramLink[] = fabric.links
  // The second LAG member folds into the bundle's one line.
  .filter((l) => l.id !== "lag-po10-2")
  .map((l) => {
    const source = atMid(l.source)
    const target = atMid(l.target)
    const level = (e?: DiagramLink["labels"]["a"]) =>
      e ? { text: e.text } : undefined
    return {
      ...l,
      source,
      target,
      points: route(l, source, target),
      labels: { mid: l.labels.mid, a: level(l.labels.a), b: level(l.labels.b) },
    }
  })

const body = { bands: fabric.bands, nodes, links, notes: fabric.notes }

export const fabricSimple: DiagramDocument = {
  meta: { ...fabric.meta, mode: "simple" },
  bounds: documentBounds(body),
  ...body,
}
