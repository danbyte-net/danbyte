import { useState } from "react"
import { BaseEdge, EdgeLabelRenderer, useInternalNode } from "@xyflow/react"
import type { EdgeProps } from "@xyflow/react"

// A protocol overlay between two cards - a BGP session today. It is not
// wiring, so it ignores ports: a faint straight line from card centre to
// card centre, and its name only while the pointer is on it.

type Box = { x: number; y: number; w: number; h: number }

function box(node: ReturnType<typeof useInternalNode>): Box | null {
  if (!node) return null
  const { x, y } = node.internals.positionAbsolute
  return { x, y, w: node.measured.width ?? 0, h: node.measured.height ?? 0 }
}

/** Where the centre-to-centre line leaves a card - so the line starts at
 * the card's border, not under its body. */
function exitPoint(from: Box, to: Box) {
  const c = { x: from.x + from.w / 2, y: from.y + from.h / 2 }
  const dx = to.x + to.w / 2 - c.x
  const dy = to.y + to.h / 2 - c.y
  if (!dx && !dy) return c
  const tx = dx ? from.w / 2 / Math.abs(dx) : Infinity
  const ty = dy ? from.h / 2 / Math.abs(dy) : Infinity
  const t = Math.min(tx, ty, 1)
  return { x: c.x + dx * t, y: c.y + dy * t }
}

export function OverlayEdge({ id, source, target, data, style }: EdgeProps) {
  const [hover, setHover] = useState(false)
  const sb = box(useInternalNode(source))
  const tb = box(useInternalNode(target))
  if (!sb || !tb) return null
  const a = exitPoint(sb, tb)
  const b = exitPoint(tb, sb)
  const d = (data ?? {}) as {
    bgp?: {
      pairs?: { a: string; b: string }[]
      kind?: string | null
      vrf?: string | null
    }
  }
  const bgp = d.bgp ?? {}
  const ep = bgp.pairs?.[0]
  const kind =
    bgp.kind === "ibgp" ? "iBGP" : bgp.kind === "ebgp" ? "eBGP" : null
  const label = [ep ? `${ep.a} ⇄ ${ep.b}` : "BGP", kind, bgp.vrf ?? null]
    .filter(Boolean)
    .join(" · ")
  const path = `M ${a.x} ${a.y} L ${b.x} ${b.y}`
  return (
    <g onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <BaseEdge
        id={id}
        path={path}
        style={{ ...style, opacity: hover ? 0.95 : (style?.opacity ?? 0.45) }}
        interactionWidth={14}
      />
      {hover && (
        <EdgeLabelRenderer>
          <div
            className="pointer-events-none rounded border border-border bg-card px-1.5 py-0.5 font-mono text-[10px] text-foreground shadow-sm"
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${(a.x + b.x) / 2}px, ${(a.y + b.y) / 2}px)`,
            }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </g>
  )
}
