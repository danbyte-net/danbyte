import { memo } from "react"
import type { CSSProperties } from "react"
import { BaseEdge, EdgeLabelRenderer, useInternalNode } from "@xyflow/react"
import type { Edge, EdgeProps, InternalNode } from "@xyflow/react"

import {
  PORT_H,
  endTextWidth,
  inlinePlaces,
  inlineSpan,
} from "@/lib/diagram/geometry"
import type { PortPlace } from "@/lib/diagram/geometry"
import { baselineAt, measureText } from "@/lib/diagram/measure"
import { LABEL } from "@/lib/diagram/theme"
import { linkEnds } from "./anchors"
import { chipCentre } from "./label-placement"
import { linkRoute, leaves, planOf, routeThrough } from "./link-geometry"
import type { Anchor, DiagramEdgeData, Rect, Route } from "./types"

// A Diagram link: one line per cable between two cards, drawn from the
// shared plan (plan.ts) so the screen and every export agree.
//
// - Simple: every line on a side meets at that side's midpoint and turns
//   off into its own lane right after it.
// - Detailed: each cable leaves its own nub.
//
// End labels - the port name, then the end's addresses - sit ON their
// cable: the line breaks for each (a box in the canvas's colour behind the
// text), so side by side every name is on its own line. While a card is
// dragged its lines are drawn unplanned (plain routes, labels one after
// another from each end) until the drop plans them again. The middle chip
// (a bundle's count, the link's subnet) sits on the line; a breakout's
// trunk carries the cable's label and type.

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

const width = (text: string) => endTextWidth(text, measureText)

/** An end label on its line: the gap the line breaks for, then the text,
 * turned to read upright. A faded link fades the text only: the gap stays
 * solid, so the line still breaks round it. */
function EndLabel({
  place,
  text,
  fade,
}: {
  place: PortPlace
  text: string
  fade?: CSSProperties
}) {
  const x = r1(place.x)
  const y = r1(place.y)
  const w = inlineSpan(width(text))
  return (
    <g
      transform={
        place.rotate ? `rotate(${r1(place.rotate)} ${x} ${y})` : undefined
      }
    >
      <rect
        x={r1(x - w / 2)}
        y={r1(y - PORT_H / 2)}
        width={r1(w)}
        height={PORT_H}
      />
      <text
        x={x}
        y={r1(baselineAt(y - PORT_H / 2, LABEL.END_SIZE, PORT_H))}
        textAnchor="middle"
        style={fade}
      >
        {text}
      </text>
    </g>
  )
}

interface Drawn {
  route: Route
  /** Each end's labels, nearest the end first, with their places. */
  a: { text: string; place: PortPlace }[]
  b: { text: string; place: PortPlace }[]
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
  const plan = planOf(data, s, t)
  const cables: Drawn[] = plan
    ? plan.map((p, i) => {
        const ends = data.labels.ends?.[i]
        const side = (end: "a" | "b") => {
          const anchor = (end === "a" ? data.a[i] : data.b[i]) as
            | Anchor
            | undefined
          const port = anchor?.k === "side" ? anchor.port : undefined
          const at = p[end]
          const ips = ends?.[end] ?? []
          const ipAt = p.ips?.[end]
          return [
            ...(port && at ? [{ text: port, place: at }] : []),
            ...(ipAt
              ? ips
                  .slice(0, ipAt.length)
                  .map((text, k) => ({ text, place: ipAt[k] }))
              : []),
          ]
        }
        return {
          route: routeThrough(p.line ?? data.line, p.pts, leaves(p.pts)),
          a: side("a"),
          b: side("b"),
        }
      })
    : linkEnds(data, s, t).map(([a, b], i) => {
        // Unplanned: the port name, then the addresses, one after
        // another from each end - where the drop will seat them.
        const route = linkRoute(data.line, a, b)
        const len = route.length
        const side = (end: "a" | "b") => {
          const anchor = (end === "a" ? data.a[i] : data.b[i]) as
            | Anchor
            | undefined
          const card = anchor?.k === "side" ? anchor : undefined
          const named =
            !data.labels.noPorts && (!data.simple || data.sem === "cable")
          const port = named ? card?.port : undefined
          const texts = [
            ...(port ? [port] : []),
            ...(card ? (data.labels.ends?.[i]?.[end] ?? []) : []),
          ]
          if (!texts.length || len < 1) return []
          const back = end === "b"
          const places = inlinePlaces((d) => {
            const at = route.at(back ? 1 - d / len : d / len)
            return { ...at, angle: back ? at.angle + 180 : at.angle }
          }, texts.map(width))
          return texts.map((text, k) => ({ text, place: places[k] }))
        }
        return { route, a: side("a"), b: side("b") }
      })
  if (!cables.length) return null
  const mid = data.labels.mid?.filter(Boolean) ?? []
  const middle = cables[Math.floor(cables.length / 2)].route
  const at = chipCentre(
    (u) => middle.at(u),
    plan ? (data.midT ?? 0.5) : 0.5,
    plan ? (data.midOff ?? 0) : 0
  )
  const fade =
    labelStyle?.opacity != null ? { opacity: labelStyle.opacity } : undefined
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
      {cables.map((c, i) =>
        c.a.length || c.b.length ? (
          <g key={`l${i}`} className="topo-endlabel">
            {[...c.a, ...c.b].map((l, k) => (
              <EndLabel key={k} place={l.place} text={l.text} fade={fade} />
            ))}
          </g>
        ) : null
      )}
      {mid.length > 0 && (
        <EdgeLabelRenderer>
          <div
            className="topo-midlabel nodrag nopan pointer-events-none absolute rounded-[5px] border border-border bg-background px-1 text-center text-[10px] leading-[13px] whitespace-nowrap text-foreground"
            style={{
              transform: `translate(-50%, -50%) translate(${r1(at.x)}px, ${r1(at.y)}px)`,
              ...fade,
              ...(data.sem === "ghost" ? { fontStyle: "italic" } : {}),
            }}
            data-hot={data.hot ? "" : undefined}
            data-crowded={plan && data.crowded ? "" : undefined}
          >
            {mid.map((line, k) => (
              <div key={k}>{line}</div>
            ))}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
})
