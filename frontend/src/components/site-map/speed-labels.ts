import L from "leaflet"

import type { SiteMapCapacity, SiteMapConnection } from "@/lib/api"
import type { DrawnCable } from "@/components/site-map/cable-geo-route"
import { connectionPaths } from "@/components/site-map/connections-layer"
import { fmtKbps } from "@/lib/speed"

// Speed labels on the site map's lines (#246): each line's capacity - "10G",
// "2×10G", "100/20M" - in a small chip on the line. Only lines in view are
// labelled, at most MAX_SPEED_LABELS at a time, and a line only once it is
// long enough on screen to carry one, so zooming in brings shorter lines'
// labels in instead of piling every label on its site. Chips never overlap:
// the longer line keeps its label.

type Pt = [number, number]

/** The most labels drawn at once. */
export const MAX_SPEED_LABELS = 300
/** Below this zoom (the whole world, a continent) no line is labelled. */
export const SPEED_LABEL_MIN_ZOOM = 5
/** A line shorter than this on screen (px, end to end) gets no label. */
export const SPEED_LABEL_MIN_PX = 72

/** A line that can carry a label: its ends, the point on it where the label
 * sits, and the label. */
export interface LabelLine {
  id: string
  label: string
  a: Pt
  z: Pt
  at: Pt
}

export interface PlacedLabel {
  id: string
  label: string
  at: Pt
}

/** The point halfway along a drawn path. Lengths are measured with a
 * degree of longitude shrunk to the latitude, so a long east-west route's
 * label lands where it looks halfway, not where the vertex count is. */
export function pathMidpoint(path: readonly Pt[]): Pt {
  if (path.length === 0) return [0, 0]
  if (path.length === 1) return path[0]
  const k = Math.cos((path[0][0] * Math.PI) / 180)
  const seg: number[] = []
  let total = 0
  for (let i = 1; i < path.length; i++) {
    const dy = path[i][0] - path[i - 1][0]
    const dx = (path[i][1] - path[i - 1][1]) * k
    const d = Math.sqrt(dx * dx + dy * dy)
    seg.push(d)
    total += d
  }
  if (total === 0) return path[0]
  let walked = 0
  for (let i = 0; i < seg.length; i++) {
    if (walked + seg[i] >= total / 2 && seg[i] > 0) {
      const t = (total / 2 - walked) / seg[i]
      const p0 = path[i]
      const p1 = path[i + 1]
      return [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t]
    }
    walked += seg[i]
  }
  return path[path.length - 1]
}

/**
 * The label for cables drawn one on top of another - between devices with
 * no coordinates of their own, every cable of a site pair runs from one
 * site's point to the other's. `2×10G` when they match, else their sum, as
 * the server adds up a bundle; a cable of unknown speed adds nothing.
 */
export function stackedLabel(
  capacities: readonly (SiteMapCapacity | null | undefined)[]
): string {
  const known = capacities.filter((c): c is SiteMapCapacity => !!c?.label)
  if (known.length === 0) return ""
  if (known.length === 1) return known[0].label
  const [first] = known
  const alike = known.every(
    (c) =>
      c.count === 1 &&
      c.unknown === 0 &&
      c.kbps === first.kbps &&
      (c.up_kbps ?? null) === (first.up_kbps ?? null)
  )
  if (alike) return `${known.length}×${first.label}`
  return fmtKbps(known.reduce((sum, c) => sum + c.kbps, 0))
}

/** Where a drawn path runs, to the metre: equal for cables on one line. */
function pathKey(path: readonly Pt[]): string {
  const at = (p: Pt) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`
  return [path[0], path[Math.floor(path.length / 2)], path[path.length - 1]]
    .map(at)
    .join("|")
}

/**
 * The lines that can carry a label: the circuit and tunnel arcs and the
 * cables the map draws, each with a known speed - cables drawn on one line
 * share one label. While a trace lights some cables, only those keep
 * theirs.
 */
export function speedLabelLines({
  connections,
  cables,
  highlight,
}: {
  connections: readonly SiteMapConnection[]
  cables: readonly DrawnCable[]
  highlight?: ReadonlySet<string>
}): LabelLine[] {
  const out: LabelLine[] = []
  const byId = new Map(connections.map((c) => [c.id, c]))
  for (const [id, path] of connectionPaths(connections)) {
    const label = byId.get(id)?.capacity?.label
    if (label)
      out.push({
        id,
        label,
        a: path[0],
        z: path[path.length - 1],
        at: path[Math.floor(path.length / 2)],
      })
  }
  const traced = highlight && highlight.size > 0 ? highlight : null
  const stacks = new Map<string, DrawnCable[]>()
  for (const c of cables) {
    if (traced && !traced.has(c.id)) continue
    if (c.path.length < 2) continue
    const key = pathKey(c.path)
    stacks.set(key, [...(stacks.get(key) ?? []), c])
  }
  for (const stack of stacks.values()) {
    const label = stackedLabel(stack.map((c) => c.capacity))
    const [c] = stack
    if (label)
      out.push({
        id: c.id,
        label,
        a: c.path[0],
        z: c.path[c.path.length - 1],
        at: pathMidpoint(c.path),
      })
  }
  return out
}

/** The chip's box on screen, from its text (10px tabular figures). */
function chipBox(label: string, x: number, y: number) {
  const w = label.length * 6.2 + 10
  const h = 16
  return { x0: x - w / 2, y0: y - h / 2, x1: x + w / 2, y1: y + h / 2 }
}

/**
 * Which lines get a label in the current view. `project` maps a point to
 * container pixels; `size` is the container. Pure, so the culling is tested
 * without a map.
 */
export function pickSpeedLabels(
  lines: readonly LabelLine[],
  view: {
    zoom: number
    size: { x: number; y: number }
    project: (p: Pt) => { x: number; y: number }
  },
  {
    max = MAX_SPEED_LABELS,
    minZoom = SPEED_LABEL_MIN_ZOOM,
    minPx = SPEED_LABEL_MIN_PX,
  }: { max?: number; minZoom?: number; minPx?: number } = {}
): PlacedLabel[] {
  if (view.zoom < minZoom || max <= 0) return []
  const { x: width, y: height } = view.size
  const candidates: { line: LabelLine; x: number; y: number; px: number }[] = []
  for (const line of lines) {
    if (!line.label) continue
    const p = view.project(line.at)
    if (p.x < 0 || p.y < 0 || p.x > width || p.y > height) continue
    const a = view.project(line.a)
    const z = view.project(line.z)
    const px = Math.hypot(z.x - a.x, z.y - a.y)
    if (px < minPx) continue
    candidates.push({ line, x: p.x, y: p.y, px })
  }
  // The longest lines first: they read best, and keep their labels when the
  // cap or a collision has to choose.
  candidates.sort((a, b) => b.px - a.px || (a.line.id < b.line.id ? -1 : 1))
  const placed: PlacedLabel[] = []
  const boxes: ReturnType<typeof chipBox>[] = []
  for (const c of candidates) {
    if (placed.length >= max) break
    const box = chipBox(c.line.label, c.x, c.y)
    if (
      boxes.some(
        (o) => box.x0 < o.x1 && box.x1 > o.x0 && box.y0 < o.y1 && box.y1 > o.y0
      )
    )
      continue
    boxes.push(box)
    placed.push({ id: c.line.id, label: c.line.label, at: c.line.at })
  }
  return placed
}

const PANE = "sm-speed-labels"

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!
  )
}

/**
 * Draw `lines`' labels on `map`, re-picked whenever the view settles. Labels
 * sit in their own pane above the lines and under the pins, and take no
 * clicks. Returns the cleanup.
 */
export function showSpeedLabels(
  map: L.Map,
  lines: readonly LabelLine[]
): () => void {
  if (!map.getPane(PANE)) {
    const pane = map.createPane(PANE)
    pane.style.zIndex = "450"
    pane.style.pointerEvents = "none"
  }
  const layer = L.layerGroup().addTo(map)
  let frame = 0
  const draw = () => {
    frame = 0
    layer.clearLayers()
    const picked = pickSpeedLabels(lines, {
      zoom: map.getZoom(),
      size: map.getSize(),
      project: (p) => map.latLngToContainerPoint(p),
    })
    for (const l of picked)
      L.marker(l.at, {
        pane: PANE,
        interactive: false,
        keyboard: false,
        icon: L.divIcon({
          className: "sm-speed-anchor",
          html: `<span class="sm-speed">${escapeHtml(l.label)}</span>`,
          iconSize: [0, 0],
        }),
      }).addTo(layer)
  }
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(draw)
  }
  draw()
  map.on("moveend zoomend resize", schedule)
  return () => {
    if (frame) cancelAnimationFrame(frame)
    map.off("moveend zoomend resize", schedule)
    layer.remove()
  }
}
