import { memo } from "react"
import type { CSSProperties } from "react"
import {
  BaseEdge,
  EdgeLabelRenderer,
  useInternalNode,
  ViewportPortal,
} from "@xyflow/react"
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
import { anchorPoint, leadStart, linkEnds } from "./anchors"
import { STACK } from "./card-layout"
import { chipCentre } from "./label-placement"
import {
  linkRoute,
  leaves,
  planOf,
  routeThrough,
  staleBend,
} from "./link-geometry"
import { nubRun } from "./plan"
import type { Anchor, DiagramEdgeData, End, Pt, Rect, Route } from "./types"

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
// another from each end) until the drop plans them again. A bendy line
// keeps the straight runs and reaches its last plan gave it, so it is
// drawn as the drop settles it when no card is in its way - except a
// breakout leg (the drop curves it as the cable page's fan-out) and a
// photo port facing away from its far end (the drop hooks it round its
// photo). The middle chip (a bundle's count, the link's subnet) sits on
// the line; a breakout's trunk carries the cable's label and type.
//
// Every line is drawn under the cards (`STACK`): a Bendy line no curve
// gets clear of passes behind them. A cable on a photo port starts at the
// port: its lead runs straight to the photo's edge over the image, so it
// is drawn a second time above the nodes.

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

/** The port name an end shows: a card nub's or a photo port's. */
const portName = (a: Anchor | undefined) =>
  (a?.k === "side" || a?.k === "point" ? a.port : undefined) || undefined

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

const leadLength = (lead: Pt, e: End) => Math.hypot(e.x - lead.x, e.y - lead.y)

/** One end of an unplanned cable: its labels (port name, then
 * addresses) and their widths, the straight run they need (`nubRun`,
 * measured here: a bendy line keeps its plan's instead, measured as the
 * plan was), and the photo lead its line starts with - only where that
 * lead runs straight into the end as it stands. */
function unplannedEnd(
  data: DiagramEdgeData,
  i: number,
  end: "a" | "b",
  at: End,
  box: Rect
): { texts: string[]; ws: number[]; run: number; lead: Pt | null } {
  const anchor = (end === "a" ? data.a[i] : data.b[i]) as Anchor | undefined
  const card =
    anchor?.k === "side" || anchor?.k === "point" ? anchor : undefined
  const named =
    !data.labels.noPorts &&
    (!data.simple || data.sem === "cable" || anchor?.k === "point")
  const port = named ? portName(card) : undefined
  const texts = [
    ...(port ? [port] : []),
    ...(card ? (data.labels.ends?.[i]?.[end] ?? []) : []),
  ]
  const ws = texts.map(width)
  const from = leadStart(box, anchor)
  const behind = (p: Pt) => {
    const [dx, dy] = [at.x - p.x, at.y - p.y]
    return (
      Math.abs(dx * at.dir[1] - dy * at.dir[0]) < 0.5 &&
      dx * at.dir[0] + dy * at.dir[1] >= 0
    )
  }
  const lead = from && behind(from) ? from : null
  // A Detailed nub or a photo port: its labels run straight out of it.
  const nub = anchor?.k === "point" || (!data.simple && anchor?.k === "side")
  return { texts, ws, run: nubRun(nub, !!from, ws), lead }
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
          const port = portName(anchor)
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
        const ea = unplannedEnd(data, i, "a", a, s)
        const eb = unplannedEnd(data, i, "b", b, t)
        // A bendy line is the curve the drop settles on when nothing is
        // in its way: its photo leads, straight past its labels, each end
        // reaching as its last plan had it (`staleBend`).
        const bend = staleBend(data.plan?.[i], () => [ea.run, eb.run])
        const pts =
          data.line === "bendy" || data.line === "cyclical"
            ? [
                ...(ea.lead ? [ea.lead] : []),
                ...linkRoute(data.line, a, b, bend).pts,
                ...(eb.lead ? [eb.lead] : []),
              ]
            : null
        const route = pts
          ? routeThrough(data.line, pts, leaves(pts))
          : linkRoute(data.line, a, b)
        const len = route.length
        const side = (end: "a" | "b") => {
          const { texts, ws, lead } = end === "a" ? ea : eb
          if (!texts.length || len < 1) return []
          const back = end === "b"
          // Past the lead: labels start where the line leaves the photo.
          const from = pts && lead ? leadLength(lead, end === "a" ? a : b) : 0
          const places = inlinePlaces((d) => {
            const u = (from + d) / len
            const at = route.at(back ? 1 - u : u)
            return { ...at, angle: back ? at.angle + 180 : at.angle }
          }, ws)
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
  // Photo ports: from the port to where the line leaves the photo.
  const leads: [Pt, Pt][] = []
  const n = Math.min(data.a.length, data.b.length)
  for (let i = 0; i < n; i++)
    for (const [box, anchor] of [
      [s, data.a[i]],
      [t, data.b[i]],
    ] as const) {
      const from = leadStart(box, anchor)
      if (!from) continue
      const to = anchorPoint(box, anchor)
      if (from.x !== to.x || from.y !== to.y) leads.push([from, to])
    }
  return (
    <>
      {leads.length > 0 && (
        <ViewportPortal>
          <svg
            aria-hidden
            className="topo-lead pointer-events-none absolute top-0 left-0 overflow-visible"
            style={{ zIndex: STACK.LEAD }}
            width={1}
            height={1}
          >
            {leads.map(([from, to], k) => (
              <path
                key={k}
                className="react-flow__edge-path"
                d={`M ${r1(from.x)},${r1(from.y)} L ${r1(to.x)},${r1(to.y)}`}
                style={style}
              />
            ))}
          </svg>
        </ViewportPortal>
      )}
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
