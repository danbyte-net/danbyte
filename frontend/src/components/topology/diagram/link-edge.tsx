import { memo } from "react"
import { BaseEdge, EdgeLabelRenderer, useInternalNode } from "@xyflow/react"
import type { Edge, EdgeProps, InternalNode } from "@xyflow/react"

import { LABEL } from "@/lib/diagram/theme"
import { linkEnds } from "./anchors"
import { linkRoute } from "./link-geometry"
import type { DiagramEdgeData, End, Rect, Route } from "./types"

// A Diagram link: one line per cable between two cards, drawn from the
// shared geometry (link-geometry.ts) so the screen and every export agree.
//
// - Simple: every line on a side meets at that side's midpoint, re-chosen
//   from the live boxes, so lines follow a card while it is dragged.
// - Detailed: each cable leaves its own nub and carries its port name
//   along the line just outside the nub, turned to read upright.
//
// A bundle's count ("2x", or its aggregates' names) sits mid-line.

type LinkEdgeType = Edge<DiagramEdgeData, "link">

/** A node's box in flow coordinates (its drawn top-left and size). */
function boxOf(n: InternalNode | undefined): Rect | null {
  if (!n) return null
  const { x, y } = n.internals.positionAbsolute
  return {
    x,
    y,
    w: n.width ?? n.measured.width ?? 0,
    h: n.height ?? n.measured.height ?? 0,
  }
}

/** The elbow channel, while both cards are still where it was routed. */
function channel(d: DiagramEdgeData, s: Rect, t: Rect) {
  if (d.line !== "elbow" || !d.wp || !d.wpAt) return undefined
  const [sx, sy, tx, ty] = d.wpAt
  const near = (a: number, b: number) => Math.abs(a - b) < 0.5
  return near(s.x, sx) && near(s.y, sy) && near(t.x, tx) && near(t.y, ty)
    ? d.wp
    : undefined
}

const r1 = (v: number) => Math.round(v * 10) / 10

/**
 * A port name along the line: starting just past the nub, rotated with the
 * line, and turned half round where it would read upside down (text on a
 * vertical line reads bottom to top).
 */
function PortLabel({
  at,
  angle,
  text,
}: {
  at: End
  angle: number
  text: string
}) {
  const rad = (angle * Math.PI) / 180
  const c = Math.cos(rad)
  const s = Math.sin(rad)
  const x = r1(at.x + c * LABEL.PORT_DIST)
  const y = r1(at.y + s * LABEL.PORT_DIST)
  const flip = c < -1e-6 || (Math.abs(c) <= 1e-6 && s > 0)
  return (
    <text
      x={x}
      y={y}
      dy={-LABEL.PORT_OFFSET}
      transform={`rotate(${r1(flip ? angle + 180 : angle)} ${x} ${y})`}
      textAnchor={flip ? "end" : "start"}
      className="topo-endlabel"
    >
      {text}
    </text>
  )
}

export const LinkEdge = memo(function LinkEdge({
  id,
  source,
  target,
  data,
  style,
  labelStyle,
}: EdgeProps<LinkEdgeType>) {
  const s = boxOf(useInternalNode(source))
  const t = boxOf(useInternalNode(target))
  if (!s || !t || !data) return null
  const wp = channel(data, s, t)
  const routes: Route[] = linkEnds(data, s, t).map(([a, b]) =>
    linkRoute(data.line, a, b, { wp })
  )
  if (!routes.length) return null
  const detailed = !data.simple
  const mid = data.labels.mid?.filter(Boolean) ?? []
  const at = routes[Math.floor(routes.length / 2)].at(data.midT ?? 0.5)
  return (
    <>
      {routes.map((r, i) => (
        <BaseEdge
          key={i}
          id={i === 0 ? id : undefined}
          path={r.d}
          style={style}
          interactionWidth={12}
        />
      ))}
      {detailed &&
        routes.map((r, i) => {
          const pa = data.a[i]?.port
          const pb = data.b[i]?.port
          if (!pa && !pb) return null
          const a = r.at(0)
          const b = r.at(1)
          return (
            <g key={`p${i}`}>
              {pa && (
                <PortLabel
                  at={{ ...a, dir: [0, 0] }}
                  angle={a.angle}
                  text={pa}
                />
              )}
              {pb && (
                <PortLabel
                  at={{ ...b, dir: [0, 0] }}
                  angle={b.angle + 180}
                  text={pb}
                />
              )}
            </g>
          )
        })}
      {mid.length > 0 && (
        <EdgeLabelRenderer>
          <div
            className="topo-midlabel nodrag nopan pointer-events-none absolute rounded-[5px] border border-border bg-background px-1 text-[10px] leading-[13px] whitespace-nowrap text-foreground"
            style={{
              transform: `translate(-50%, -50%) translate(${r1(at.x)}px, ${r1(at.y)}px)`,
              ...(labelStyle?.opacity != null
                ? { opacity: labelStyle.opacity }
                : {}),
              ...(data.sem === "ghost" ? { fontStyle: "italic" } : {}),
            }}
            data-hot={data.hot ? "" : undefined}
          >
            {mid.join(" · ")}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
})
