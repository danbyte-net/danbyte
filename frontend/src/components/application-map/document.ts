import { documentBounds } from "@/lib/diagram/geometry"
import type { Measure } from "@/lib/diagram/measure"
import { PRINT, mix, printColor } from "@/lib/diagram/theme"
import type {
  DiagramBand,
  DiagramDocument,
  DiagramLink,
  DiagramMeta,
  DiagramNode,
} from "@/lib/diagram/types"
import { linkEnds } from "@/components/topology/diagram/anchors"
import { linkRoute } from "@/components/topology/diagram/link-geometry"
import {
  cardNode,
  danbyteUrl,
  endSide,
  routeLink,
} from "@/components/topology/diagram/to-document"
import type { Rect } from "@/components/topology/diagram/types"

import type { AppCardData, AppMapGraph, AppMapRef } from "./model"

// The Application map as an export document (#163): the cards where they
// stand now (dragged or laid out), the row bands, and every line routed by
// the Diagram's own geometry with its arrowheads, its status colour and its
// protocol labels - in the print theme, whatever the app's theme. Built
// from the map's nodes and edges, never the DOM, so the PNG, SVG, PDF and
// draw.io files carry every card, on screen or not.

export interface AppDocumentOptions {
  meta: Omit<DiagramMeta, "mode">
  /** Scheme and host for the links back ("https://…"); paths without. */
  origin?: string
  measure?: Measure
}

/** The page a card's object lives on. */
export function refPath(ref: AppMapRef): string | undefined {
  if (ref.kind === "application") return `/applications/${ref.app.id}`
  if (ref.kind === "host")
    return ref.host.kind === "device"
      ? `/devices/${ref.host.id}`
      : `/virtual-machines/${ref.host.id}`
  const e = ref.end
  if (!e.id) return undefined
  if (e.kind === "ip") return `/ips/${e.id}`
  if (e.kind === "prefix") return `/prefixes/${e.id}`
  if (e.kind === "range") return `/ip-ranges/${e.id}`
  return undefined
}

export function appMapDocument(
  graph: AppMapGraph,
  opts: AppDocumentOptions
): DiagramDocument {
  const link = (path?: string) =>
    path ? danbyteUrl(opts.origin, path) : undefined
  const boxes = new Map<string, Rect>()
  const nodes: DiagramNode[] = []
  for (const n of graph.nodes) {
    if (n.hidden) continue
    const d: AppCardData = n.data
    const box = d.diagram.box
    boxes.set(n.id, {
      x: n.position.x - box.w / 2,
      y: n.position.y - box.h / 2,
      w: box.w,
      h: box.h,
    })
    nodes.push(
      cardNode(n.id, n.position, box, d.input, {
        link: link(refPath(d.ref)),
        measure: opts.measure,
      })
    )
  }

  const links: DiagramLink[] = []
  for (const e of graph.edges) {
    const s = boxes.get(e.source)
    const t = boxes.get(e.target)
    const d = e.data
    if (e.hidden || !s || !t || !d) continue
    const [[a, b]] = linkEnds({ a: [], b: [], simple: true }, s, t)
    const route = linkRoute(d.line, a, b)
    const color = printStroke(d.paint.stroke)
    links.push(
      routeLink(
        e.id,
        e.source,
        e.target,
        route,
        [
          { node: e.source, x: a.x, y: a.y, side: endSide(a) },
          { node: e.target, x: b.x, y: b.y, side: endSide(b) },
        ],
        {
          sem: "cable",
          // A retired line is faded on screen; print mixes it into the
          // paper instead (the writers draw no opacity).
          stroke: d.paint.faded ? mixPaper(color) : color,
          width: d.paint.width,
          ...(d.paint.dash ? { dash: d.paint.dash } : {}),
          labels: d.labels.mid?.length ? { mid: [...d.labels.mid] } : {},
          ...(d.arrow === "none"
            ? {}
            : d.arrow === "both"
              ? { arrow: "both" as const }
              : { arrow: "end" as const }),
        }
      )
    )
    // An arrow at the source only: the line is drawn the other way round.
    if (d.arrow === "start") {
      const l = links[links.length - 1]
      links[links.length - 1] = {
        ...l,
        source: l.target,
        target: l.source,
        points: [...l.points].reverse(),
      }
    }
  }

  const bands: DiagramBand[] = graph.bands.map((b) => ({
    id: b.id,
    kind: "row",
    orient: "h",
    label: b.label,
    fill: null,
    x: b.x,
    y: b.y,
    w: b.w,
    h: b.h,
  }))

  const doc: DiagramDocument = {
    meta: { ...opts.meta },
    bounds: { x: 0, y: 0, w: 0, h: 0 },
    bands,
    nodes,
    links,
    notes: [],
  }
  doc.bounds = documentBounds(doc, opts.measure)
  return doc
}

/** A line's print colour: its own, a theme variable's print value, or the
 * cable grey. */
function printStroke(stroke: string | undefined): string {
  return printColor(stroke, PRINT.subtle)
}

/** A faded line's colour: half way into the paper. */
function mixPaper(color: string): string {
  return mix(color, PRINT.paper, 0.45)
}
