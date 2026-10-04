import type { Edge, Node } from "@xyflow/react"

import type { TopoEdge, TopoNode } from "@/lib/api"
import { documentBounds } from "@/lib/diagram/geometry"
import { measureText } from "@/lib/diagram/measure"
import type { Measure } from "@/lib/diagram/measure"
import type {
  DiagramDocument,
  DiagramLink,
  DiagramNode,
} from "@/lib/diagram/types"
import { linkEnds } from "../diagram/anchors"
import { cardContent, withCardLines } from "../diagram/card-fields"
import { cardLayout } from "../diagram/card-layout"
import type { CardLayoutInput } from "../diagram/card-layout"
import { distinctCables } from "../diagram/build-diagram"
import { linkRoute } from "../diagram/link-geometry"
import {
  cardNode,
  checkNames,
  danbyteUrl,
  endSide,
  fitBox,
  linkPaint,
  regionBands,
  routeLink,
  viewNotes,
} from "../diagram/to-document"
import type {
  CheckLook,
  DocumentOptions,
  MonitorMap,
  Region,
} from "../diagram/to-document"
import type { Rect } from "../diagram/types"
import type { BundleMember } from "../edge-semantics"
import type { GroupEdgeInfo, TopoGroupData } from "../group-node"
import { sizeOf } from "../node-registry"

// The Hierarchy tab as an export document, in the Diagram's Simple look:
// each device a compact role-coloured card centred where its card sits on
// the tab, and one straight line per device pair between the facing side
// midpoints, with a count chip when it stands for several cables. Its port
// chips and aligned cables are how that tab draws, not what the map says,
// so the PNG, SVG, PDF and draw.io files of every tab read the same. Built
// from the canvas's nodes and edges - never the DOM.

/** Node kinds drawn as device cards. */
const DEVICE_KINDS = new Set(["hier", "card"])

type FlowEdgeData = {
  sem?: string
  raw?: TopoEdge["data"]
  bgp?: TopoEdge["data"]
  cables?: BundleMember[]
  group?: GroupEdgeInfo
}

/** A Hierarchy node's card: the payload's own card lines when it has them
 * (the Hierarchy asks for them), else the primary IP - the one default line
 * those tabs' payload carries. The pill follows the card lines as on a
 * Diagram card: none unless they list the status or monitoring. */
function cardInput(
  d: TopoNode["data"],
  monitor: MonitorMap | undefined,
  checks: CheckLook | undefined
): {
  input: CardLayoutInput
  pill: ReturnType<typeof cardContent>["pill"]
} {
  const content = cardContent(withCardLines(d), {
    monitor: d.device_id ? monitor?.[d.device_id]?.status : undefined,
    checkLabels: checkNames(checks),
  })
  return {
    input: {
      name: content.name,
      color: d.role?.color,
      lines: content.lines,
      pillSlot: content.pillSlot,
    },
    pill: content.pill,
  }
}

/** How many cables a Hierarchy edge stands for: a breakout cable's port
 * pairs are one cable. */
function cables(d: FlowEdgeData): number {
  if (d.group) return Math.max(1, d.group.cable_count)
  if (d.cables?.length) return distinctCables(d.cables)
  return 1
}

const WIRING = new Set(["cable", "lagbundle", "bundle", "groupedge"])

const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/** The Hierarchy's canvas as a Simple document. `regions` are its zones. */
export function fromFlow(
  flowNodes: readonly Node[],
  flowEdges: readonly Edge[],
  regions: readonly Region[],
  opts: Omit<DocumentOptions, "mode">
): DiagramDocument {
  const measure: Measure = opts.measure ?? measureText
  const area = opts.area ?? null

  const rects = new Map<string, Rect>()
  const nodes: DiagramNode[] = []
  for (const n of flowNodes) {
    if (n.hidden) continue
    const device = DEVICE_KINDS.has(n.type ?? "")
    if (!device && n.type !== "sitegroup") continue
    // Hierarchy cards are placed by their top-left corner; each export card is
    // centred on the card it stands for.
    const s = sizeOf(n)
    const c = n.origin
      ? { x: n.position.x, y: n.position.y }
      : { x: n.position.x + s.width / 2, y: n.position.y + s.height / 2 }
    if (device) {
      const d = n.data as TopoNode["data"]
      const { input, pill } = cardInput(d, opts.monitor, opts.checkLabels)
      const box = cardLayout(input, null, measure)
      const r = { x: c.x - box.w / 2, y: c.y - box.h / 2, w: box.w, h: box.h }
      if (area && !overlaps(area, r)) continue
      rects.set(n.id, r)
      nodes.push(
        cardNode(n.id, c, box, input, {
          pill,
          checks: opts.checkLabels,
          link: d.device_id
            ? danbyteUrl(opts.origin, `/devices/${d.device_id}`)
            : undefined,
          measure,
        })
      )
    } else {
      const g = n.data as unknown as TopoGroupData
      const r = {
        x: c.x - s.width / 2,
        y: c.y - s.height / 2,
        w: s.width,
        h: s.height,
      }
      if (area && !overlaps(area, r)) continue
      const input: CardLayoutInput = {
        name: g.name,
        lines: [
          {
            key: "count",
            text: `${g.device_count} device${g.device_count === 1 ? "" : "s"}`,
          },
        ],
      }
      rects.set(n.id, r)
      nodes.push(
        cardNode(n.id, c, fitBox(input, { w: r.w, h: r.h }, measure), input, {
          measure,
        })
      )
    }
  }

  // One line per device pair for the wiring; LLDP neighbours and BGP
  // sessions keep their own.
  const groups = new Map<string, Edge[]>()
  const order: (string | Edge)[] = []
  for (const e of flowEdges) {
    if (e.hidden || !rects.has(e.source) || !rects.has(e.target)) continue
    const sem = (e.data as FlowEdgeData | undefined)?.sem
    if (sem === "ghost" || sem === "bgp") {
      order.push(e)
      continue
    }
    if (!sem || !WIRING.has(sem)) continue
    const key = [e.source, e.target].sort().join("|")
    const g = groups.get(key)
    if (g) g.push(e)
    else {
      groups.set(key, [e])
      order.push(key)
    }
  }

  const links: DiagramLink[] = []
  for (const item of order) {
    const group = typeof item === "string" ? groups.get(item)! : [item]
    const e = group[0]
    const d = (e.data ?? {}) as FlowEdgeData
    const n = group.reduce((sum, x) => sum + cables(x.data as FlowEdgeData), 0)
    const sem =
      d.sem === "ghost" || d.sem === "bgp"
        ? d.sem
        : n > 1 || d.sem === "lagbundle" || d.sem === "bundle"
          ? "bundle"
          : "cable"
    const strokes = new Set(group.map((x) => String(x.style?.stroke ?? "")))
    const paint = linkPaint(
      sem,
      group.length === 1
        ? e.style
        : {
            strokeWidth: 1.75,
            ...(strokes.size === 1 ? { stroke: e.style?.stroke } : {}),
          }
    )
    const s = rects.get(e.source)!
    const t = rects.get(e.target)!
    const [[a, b]] = linkEnds({ a: [], b: [], simple: true }, s, t)
    const mid =
      sem === "ghost" ? ["LLDP"] : sem !== "bgp" && n > 1 ? [`${n}x`] : []
    const cableId =
      group.length === 1 && d.sem === "cable" ? d.raw?.cable_id : undefined
    const session = sem === "bgp" ? d.bgp?.sessions?.[0] : undefined
    const link = cableId
      ? danbyteUrl(opts.origin, `/cables/${cableId}`)
      : session
        ? danbyteUrl(opts.origin, `/bgp-sessions/${session}`)
        : undefined
    links.push(
      routeLink(
        group.length > 1 ? `${e.id}+${group.length - 1}` : e.id,
        e.source,
        e.target,
        linkRoute("straight", a, b),
        [
          { node: e.source, x: a.x, y: a.y, side: endSide(a) },
          { node: e.target, x: b.x, y: b.y, side: endSide(b) },
        ],
        {
          sem,
          ...paint,
          labels: mid.length ? { mid } : {},
          ...(link ? { link } : {}),
        }
      )
    )
  }

  const bands = regionBands(regions, area)
  const notes = viewNotes(opts.notes, area)
  const body = { bands, nodes, links, notes }
  return {
    meta: { ...opts.meta, mode: "simple" },
    bounds: documentBounds(body, measure),
    ...body,
  }
}
