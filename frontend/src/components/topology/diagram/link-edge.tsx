import { memo } from "react"
import { BaseEdge, EdgeLabelRenderer, useInternalNode } from "@xyflow/react"
import type { Edge, EdgeProps, InternalNode } from "@xyflow/react"

import { PORT_H, routePortPlace } from "@/lib/diagram/geometry"
import type { PortPlace } from "@/lib/diagram/geometry"
import { baselineAt, measureText } from "@/lib/diagram/measure"
import { LABEL } from "@/lib/diagram/theme"
import { linkEnds } from "./anchors"
import { chipCentre } from "./label-placement"
import { leaves, linkRoute, planOf, routeThrough } from "./link-geometry"
import type { DiagramEdgeData, Rect, Route } from "./types"

// A Diagram link: one line per cable between two cards, drawn from the
// shared plan (plan.ts) so the screen and every export agree.
//
// - Simple: every line on a side meets at that side's midpoint and turns
//   off into its own lane right after it.
// - Detailed: each cable leaves its own nub and carries its port name
//   along its first straight run, turned to read upright.
//
// While a card is dragged its lines are drawn unplanned (plain routes,
// names just past the nub) until the drop plans them again. A bundle's
// count ("2x", or its aggregates' names) sits mid-line; a breakout's trunk
// carries the cable's label and type.

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

const r1 = (v: number) => Math.round(v * 10) / 10

/** A port name at its place: centred, turned to read upright. */
function PortLabel({ place, text }: { place: PortPlace; text: string }) {
  const x = r1(place.x)
  const y = r1(place.y)
  const base = r1(baselineAt(place.y - PORT_H / 2, LABEL.END_SIZE, PORT_H))
  return (
    <text
      x={x}
      y={base}
      transform={
        place.rotate ? `rotate(${r1(place.rotate)} ${x} ${y})` : undefined
      }
      textAnchor="middle"
      className="topo-endlabel"
    >
      {text}
    </text>
  )
}

interface Drawn {
  route: Route
  a?: PortPlace | null
  b?: PortPlace | null
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
  const detailed = !data.simple
  const plan = planOf(data, s, t)
  const cables: Drawn[] = plan
    ? plan.map((p) => ({
        route: routeThrough(data.line, p.pts, leaves(p.pts)),
        a: p.a,
        b: p.b,
      }))
    : linkEnds(data, s, t).map(([a, b], i) => {
        const route = linkRoute(data.line, a, b)
        const place = (text: string | undefined, fromEnd: boolean) =>
          text && detailed
            ? routePortPlace(
                route.pts,
                fromEnd,
                measureText(text, LABEL.END_SIZE, 400)
              )
            : undefined
        const pa = data.a[i]?.k === "side" ? data.a[i] : undefined
        const pb = data.b[i]?.k === "side" ? data.b[i] : undefined
        return {
          route,
          a: place(pa?.k === "side" ? pa.port : undefined, false),
          b: place(pb?.k === "side" ? pb.port : undefined, true),
        }
      })
  if (!cables.length) return null
  const mid = data.labels.mid?.filter(Boolean) ?? []
  const middle = cables[Math.floor(cables.length / 2)].route
  const at = chipCentre(
    (u) => middle.at(u),
    plan ? (data.midT ?? 0.5) : 0.5,
    plan ? (data.midOff ?? 0) : 0
  )
  return (
    <>
      {cables.map((c, i) => (
        <BaseEdge
          key={i}
          id={i === 0 ? id : undefined}
          path={c.route.d}
          style={style}
          interactionWidth={12}
        />
      ))}
      {detailed &&
        cables.map((c, i) => {
          const pa = data.a[i]?.k === "side" ? data.a[i] : undefined
          const pb = data.b[i]?.k === "side" ? data.b[i] : undefined
          const ta = pa?.k === "side" ? pa.port : undefined
          const tb = pb?.k === "side" ? pb.port : undefined
          if (!(ta && c.a) && !(tb && c.b)) return null
          return (
            <g key={`p${i}`}>
              {ta && c.a && <PortLabel place={c.a} text={ta} />}
              {tb && c.b && <PortLabel place={c.b} text={tb} />}
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
            data-crowded={plan && data.crowded ? "" : undefined}
          >
            {mid.join(" · ")}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
})
