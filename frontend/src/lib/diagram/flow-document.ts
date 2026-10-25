import type { ApplicationFlow, FlowEnd } from "@/lib/api"
import { endHost, endKey, flowServiceLabel } from "@/lib/flows"

import { documentBounds } from "./geometry"
import { measureText } from "./measure"
import type { Measure } from "./measure"
import {
  BAND,
  CARD,
  LINK_DEFAULTS,
  NEUTRAL_CARD,
  cardTextHeight,
} from "./theme"
import type {
  DiagramBand,
  DiagramDocument,
  DiagramLink,
  DiagramNode,
  Side,
} from "./types"

// An application's flows as a diagram (#163): one card per end - an
// address (titled with its device or VM when it has one), a range, a prefix
// or "Any" - in ranked columns, sources left and destinations right; one
// row band per application; one arrowed line per flow with its protocol and
// ports in the middle ("TCP 443"). The layout is a small rank layout of its
// own: deterministic (the same flows, in any order, give the same
// document), with no dependency. Every writer (SVG, PNG, draw.io, PDF)
// draws the result.

export const FLOW_LAYOUT = {
  /** Between two columns, room for the middle labels. */
  COL_GAP: 150,
  ROW_GAP: 24,
  /** Inside a band, round its cards. */
  BAND_PAD: 24,
  /** Between two application bands. */
  BAND_GAP: 32,
  MIN_W: 140,
  MAX_W: 260,
  /** Between parallel lines joining the same two cards. */
  PAIR_STEP: 10,
  /** How far a line between two cards of one column runs out to the right. */
  LOOP_OUT: 28,
} as const

export interface FlowDocumentOptions {
  /** The diagram's title: the application's name. */
  title: string
  /** ISO timestamp, injected (fixed in tests). */
  generatedAt: string
  tenant?: string
  /** Absolute origin for the links back to Danbyte ("https://…"); none
   * when absent. */
  origin?: string
  /** The application's page, for the title block's link. */
  applicationId?: string
  measure?: Measure
}

interface EndCard {
  key: string
  end: FlowEnd
  title: string
  lines: string[]
  rank: number
  order: number
  x: number
  y: number
  w: number
  h: number
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** An end's card text: the device or VM when the address has one, the
 * address, range or prefix under it; else the end itself. */
function cardOf(end: FlowEnd): { title: string; lines: string[] } {
  const host = endHost(end)
  if (host) return { title: host.name, lines: [end.label] }
  return { title: end.kind === "any" ? "Any" : end.label, lines: [] }
}

const endPath = (e: FlowEnd): string | undefined =>
  !e.id
    ? undefined
    : e.kind === "ip"
      ? `/ips/${e.id}`
      : e.kind === "prefix"
        ? `/prefixes/${e.id}`
        : e.kind === "range"
          ? `/ip-ranges/${e.id}`
          : undefined

/** Ranks: a card no flow reaches is 0, every other one past the furthest
 * card that reaches it. A cycle is broken at the card with the fewest
 * unranked sources, then the most flows out, then by key - so the ranks
 * follow most of the traffic and never depend on the order the flows came
 * in. */
function rank(cards: Map<string, EndCard>, edges: [string, string][]) {
  const preds = new Map<string, Set<string>>()
  const out = new Map<string, number>()
  for (const k of cards.keys()) preds.set(k, new Set())
  for (const [s, t] of edges)
    if (s !== t) {
      preds.get(t)!.add(s)
      out.set(s, (out.get(s) ?? 0) + 1)
    }
  const done = new Set<string>()
  const keys = [...cards.keys()].sort(cmp)
  while (done.size < keys.length) {
    const left = keys.filter((k) => !done.has(k))
    // The cards whose sources are all ranked; in a cycle, one card.
    const unranked = (k: string) =>
      [...preds.get(k)!].filter((p) => !done.has(p)).length
    let ready = left.filter((k) => unranked(k) === 0)
    if (!ready.length) {
      const least = Math.min(...left.map(unranked))
      const tied = left.filter((k) => unranked(k) === least)
      const most = Math.max(...tied.map((k) => out.get(k) ?? 0))
      ready = [tied.find((k) => (out.get(k) ?? 0) === most)!]
    }
    for (const k of ready) {
      const ranked = [...preds.get(k)!].filter((p) => done.has(p))
      cards.get(k)!.rank = ranked.length
        ? Math.max(...ranked.map((p) => cards.get(p)!.rank)) + 1
        : 0
    }
    for (const k of ready) done.add(k)
  }
  return preds
}

/** One application's flows: its cards placed in columns from `x0, y0`;
 * returns the content's size. */
function placeGroup(
  cards: Map<string, EndCard>,
  preds: Map<string, Set<string>>,
  x0: number,
  y0: number,
  measure: Measure
): { w: number; h: number } {
  const columns: EndCard[][] = []
  for (const c of cards.values()) (columns[c.rank] ??= []).push(c)
  for (let r = 0; r < columns.length; r++) {
    const col = columns[r] ?? []
    columns[r] = col
    // Rank 0 reads by name; later columns sit by where their sources sit.
    const centre = (c: EndCard) => {
      const ps = [...preds.get(c.key)!]
        .map((p) => cards.get(p)!)
        .filter((p) => p.rank < r)
      return ps.length
        ? ps.reduce((s, p) => s + p.order, 0) / ps.length
        : Number.POSITIVE_INFINITY
    }
    const at = new Map(col.map((c) => [c.key, r === 0 ? 0 : centre(c)]))
    col.sort(
      (a, b) =>
        at.get(a.key)! - at.get(b.key)! ||
        cmp(a.title, b.title) ||
        cmp(a.key, b.key)
    )
    col.forEach((c, i) => (c.order = i))
  }
  const widths = columns.map((col) =>
    Math.min(
      FLOW_LAYOUT.MAX_W,
      Math.max(
        FLOW_LAYOUT.MIN_W,
        ...col.map(
          (c) =>
            Math.ceil(
              Math.max(
                measure(c.title, CARD.TITLE_SIZE, CARD.TITLE_WEIGHT),
                ...c.lines.map((l) =>
                  measure(l, CARD.LINE_SIZE, CARD.LINE_WEIGHT)
                )
              )
            ) +
            2 * CARD.PAD_X +
            8
        )
      )
    )
  )
  const heights = columns.map((col) =>
    col.reduce(
      (s, c, i) =>
        s + cardTextHeight(c.lines.length) + (i ? FLOW_LAYOUT.ROW_GAP : 0),
      0
    )
  )
  const h = Math.max(0, ...heights)
  let x = x0
  columns.forEach((col, r) => {
    let y = y0 + (h - heights[r]) / 2
    for (const c of col) {
      c.x = x
      c.y = y
      c.w = widths[r]
      c.h = cardTextHeight(c.lines.length)
      y += c.h + FLOW_LAYOUT.ROW_GAP
    }
    x += widths[r] + FLOW_LAYOUT.COL_GAP
  })
  const w = x - x0 - (columns.length ? FLOW_LAYOUT.COL_GAP : 0)
  return { w, h }
}

/** The flows of one or more applications as a diagram document. */
export function buildFlowDocument(
  flows: readonly ApplicationFlow[],
  opts: FlowDocumentOptions
): DiagramDocument {
  const measure = opts.measure ?? measureText
  const abs = (path?: string) =>
    path && opts.origin ? `${opts.origin}${path}` : undefined

  // Applications by their path, then id; flows by name, then id.
  const groups = new Map<string, ApplicationFlow[]>()
  for (const f of flows) {
    const g = groups.get(f.application.id) ?? []
    g.push(f)
    groups.set(f.application.id, g)
  }
  const ordered = [...groups.values()]
    .map((g) => [...g].sort((a, b) => cmp(a.name, b.name) || cmp(a.id, b.id)))
    .sort(
      (a, b) =>
        cmp(
          a[0].application.path || a[0].application.name,
          b[0].application.path || b[0].application.name
        ) || cmp(a[0].application.id, b[0].application.id)
    )

  const bands: DiagramBand[] = []
  const nodes: DiagramNode[] = []
  const links: DiagramLink[] = []
  const placed: {
    app: ApplicationFlow["application"]
    cards: Map<string, EndCard>
    size: { w: number; h: number }
    top: number
    flows: ApplicationFlow[]
  }[] = []

  let top = 0
  for (const group of ordered) {
    const app = group[0].application
    const cards = new Map<string, EndCard>()
    const edges: [string, string][] = []
    for (const f of group) {
      const keys = (["source", "destination"] as const).map((side) => {
        const end = f[side]
        const key = endKey(end, side)
        if (!cards.has(key))
          cards.set(key, {
            key,
            end,
            ...cardOf(end),
            rank: 0,
            order: 0,
            x: 0,
            y: 0,
            w: 0,
            h: 0,
          })
        return key
      })
      edges.push([keys[0], keys[1]])
    }
    const preds = rank(cards, edges)
    const inner = top + BAND.ROW_TITLE + FLOW_LAYOUT.BAND_PAD / 2
    const size = placeGroup(cards, preds, FLOW_LAYOUT.BAND_PAD, inner, measure)
    placed.push({ app, cards, size, top, flows: group })
    top +=
      BAND.ROW_TITLE +
      FLOW_LAYOUT.BAND_PAD / 2 +
      size.h +
      FLOW_LAYOUT.BAND_PAD +
      FLOW_LAYOUT.BAND_GAP
  }

  // Every band as wide as the widest, so they read as rows of one sheet.
  const width = Math.max(0, ...placed.map((p) => p.size.w))
  for (const { app, cards, size, top: y, flows: group } of placed) {
    bands.push({
      id: `app:${app.id}`,
      kind: "row",
      orient: "h",
      label: app.path || app.name,
      fill: null,
      x: 0,
      y,
      w: width + 2 * FLOW_LAYOUT.BAND_PAD,
      h:
        BAND.ROW_TITLE +
        FLOW_LAYOUT.BAND_PAD / 2 +
        size.h +
        FLOW_LAYOUT.BAND_PAD,
    })
    const sorted = [...cards.values()].sort(
      (a, b) => a.rank - b.rank || a.order - b.order
    )
    for (const c of sorted)
      nodes.push({
        id: `${app.id}:${c.key}`,
        kind: "card",
        fill: NEUTRAL_CARD.fill,
        ink: NEUTRAL_CARD.ink,
        title: c.title,
        lines: c.lines,
        x: c.x,
        y: c.y,
        w: c.w,
        h: c.h,
        link: abs(endPath(c.end)),
      })

    // Parallel lines between the same two cards spread apart.
    const pairs = new Map<string, ApplicationFlow[]>()
    for (const f of group) {
      const [a, b] = [
        endKey(f.source, "source"),
        endKey(f.destination, "destination"),
      ].sort(cmp)
      const k = `${a}|${b}`
      pairs.set(k, [...(pairs.get(k) ?? []), f])
    }
    let loops = 0
    for (const f of group) {
      const s = cards.get(endKey(f.source, "source"))!
      const t = cards.get(endKey(f.destination, "destination"))!
      const [a, b] = [s.key, t.key].sort(cmp)
      const pair = pairs.get(`${a}|${b}`)!
      const i = pair.indexOf(f)
      const room = Math.max(0, Math.min(s.h, t.h) / 2 - 4)
      const off = Math.max(
        -room,
        Math.min(room, (i - (pair.length - 1) / 2) * FLOW_LAYOUT.PAIR_STEP)
      )
      const sy = s.y + s.h / 2 + off
      const ty = t.y + t.h / 2 + off
      const end = (c: EndCard, side: Side, at: number) => ({
        node: `${app.id}:${c.key}`,
        side,
        x: side === "right" ? c.x + c.w : c.x,
        y: at,
      })
      let link: Pick<DiagramLink, "kind" | "source" | "target" | "points">
      if (t.rank > s.rank)
        link = {
          kind: "straight",
          source: end(s, "right", sy),
          target: end(t, "left", ty),
          points: [],
        }
      else if (t.rank < s.rank)
        link = {
          kind: "straight",
          source: end(s, "left", sy),
          target: end(t, "right", ty),
          points: [],
        }
      else {
        // Two cards of one column (or one card to itself): out to the
        // right and back, each such line a step further out.
        const out = s.x + s.w + FLOW_LAYOUT.LOOP_OUT + 8 * loops++
        const [y1, y2] = s === t ? [sy - 6, sy + 6] : [sy, ty]
        link = {
          kind: "elbow",
          source: end(s, "right", y1),
          target: end(t, "right", y2),
          points: [
            { x: out, y: y1 },
            { x: out, y: y2 },
          ],
        }
      }
      links.push({
        id: `flow:${f.id}`,
        ...link,
        sem: "cable",
        stroke: LINK_DEFAULTS.cable.stroke,
        width: LINK_DEFAULTS.cable.width,
        labels: { mid: [flowServiceLabel(f)] },
        arrow: f.direction === "both" ? "both" : "end",
      })
    }
  }

  const doc: DiagramDocument = {
    meta: {
      title: opts.title,
      tenant: opts.tenant,
      generated_at: opts.generatedAt,
      filters: `${flows.length} ${flows.length === 1 ? "flow" : "flows"}`,
      danbyte_url: abs(
        opts.applicationId ? `/applications/${opts.applicationId}` : undefined
      ),
    },
    bounds: { x: 0, y: 0, w: 0, h: 0 },
    bands,
    nodes,
    links,
    notes: [],
  }
  doc.bounds = documentBounds(doc, measure)
  return doc
}
