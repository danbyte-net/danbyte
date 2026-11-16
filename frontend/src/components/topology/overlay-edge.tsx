import { useState } from "react"
import { BaseEdge, useInternalNode } from "@xyflow/react"
import type { EdgeProps } from "@xyflow/react"

// An overlay between two cards - a BGP session, or a device dependency
// (#450). It is not wiring, so it ignores ports: a faint straight line from
// card centre to card centre that brightens under the pointer. A dependency
// carries an arrow at its downstream card and its redundancy group as a
// small label. Its name is the canvas's hover tip, like every other line's
// (see `bgpLabel`, `dependencyLabel`).

export type Box = { x: number; y: number; w: number; h: number }

export function box(node: ReturnType<typeof useInternalNode>): Box | null {
  if (!node) return null
  const { x, y } = node.internals.positionAbsolute
  return { x, y, w: node.measured.width ?? 0, h: node.measured.height ?? 0 }
}

/** Where the centre-to-centre line leaves a card - so the line starts at
 * the card's border, not under its body. */
export function exitPoint(from: Box, to: Box) {
  const c = { x: from.x + from.w / 2, y: from.y + from.h / 2 }
  const dx = to.x + to.w / 2 - c.x
  const dy = to.y + to.h / 2 - c.y
  if (!dx && !dy) return c
  const tx = dx ? from.w / 2 / Math.abs(dx) : Infinity
  const ty = dy ? from.h / 2 / Math.abs(dy) : Infinity
  const t = Math.min(tx, ty, 1)
  return { x: c.x + dx * t, y: c.y + dy * t }
}

/** What a BGP session line says on hover: its two ends, the session kind and
 * the VRF ("r1 ↔ r2 · eBGP · blue"). The canvas shows it in its one tip. */
export function bgpLabel(bgp: {
  pairs?: { a: string; b: string }[]
  kind?: string | null
  vrf?: string | null
}): string {
  const ep = bgp.pairs?.[0]
  const kind =
    bgp.kind === "ibgp" ? "iBGP" : bgp.kind === "ebgp" ? "eBGP" : null
  return [ep ? `${ep.a} ↔ ${ep.b}` : "BGP", kind, bgp.vrf ?? null]
    .filter(Boolean)
    .join(" · ")
}

/** What a dependency line says on hover: "acc-7 depends on dist-2 · Fibre
 * · group uplinks", or for a peer link "a ↔ b · peer". */
export function dependencyLabel(d: {
  kind?: string | null
  upstream?: string
  downstream?: string
  medium?: { name: string } | null
  redundancy_group?: string
}): string {
  const head =
    d.kind === "peer"
      ? `${d.upstream ?? "?"} ↔ ${d.downstream ?? "?"} · peer`
      : `${d.downstream ?? "?"} depends on ${d.upstream ?? "?"}`
  return [
    head,
    d.medium?.name ?? null,
    d.redundancy_group ? `group ${d.redundancy_group}` : null,
  ]
    .filter(Boolean)
    .join(" · ")
}

export function OverlayEdge({
  id,
  source,
  target,
  style,
  markerEnd,
  label,
  labelStyle,
}: EdgeProps) {
  const [hover, setHover] = useState(false)
  const sb = box(useInternalNode(source))
  const tb = box(useInternalNode(target))
  if (!sb || !tb) return null
  const a = exitPoint(sb, tb)
  const b = exitPoint(tb, sb)
  const path = `M ${a.x} ${a.y} L ${b.x} ${b.y}`
  return (
    <g onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        label={label}
        labelX={(a.x + b.x) / 2}
        labelY={(a.y + b.y) / 2}
        labelStyle={labelStyle}
        labelBgStyle={{ fill: "var(--card)" }}
        labelBgPadding={[3, 1]}
        style={{ ...style, opacity: hover ? 0.95 : (style?.opacity ?? 0.45) }}
        interactionWidth={14}
      />
    </g>
  )
}
