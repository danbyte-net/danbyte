/**
 * Cable ways in 3D (docs/dcim/racks.md → Cable ways → In 3D): where a
 * cable runs through its rack's managers, entries and 0U channels, the
 * lanes cables sharing a manager take inside it, the bundle a manager's
 * cables make from afar, and its indicative fill. Pure - the rack's ways
 * layer (cable-ways-3d) and the room's runs (cable-trace-3d) draw from it.
 *
 * The server places every pathway in the rack's own millimetres
 * (api.rack_pathways.Room): `x` right of the centre seen from the front,
 * `y` behind the front, `z` above the floor. The rack group's frame is
 * metres with +x to the left seen from the front, y up and the front plane
 * on −Z (rack-mesh), so `rackLocal` turns one into the other.
 */
import { PANEL_MM } from "@/lib/faceplate-geometry"

import { mm, rackBaseM, rackFootprintM } from "./world"
import type { SceneRack, Tier } from "./world"

export type Vec3 = [number, number, number]

/** A vertical or horizontal manager's place (mm): its outer box, the
 * centre of its inner cross-section, its wall, where cables enter it
 * (spec §14 v1.16 `danbyte_open`) and its finger pitch. */
export interface ManagerGeo {
  x0: number
  x1: number
  y0: number
  y1: number
  z0: number
  z1: number
  cx: number
  cy: number
  wall: number
  open: "front" | "rear" | "inner" | "outer" | "ends"
  pitch_mm: number | null
}

/** An entry's opening (mm): its centre on the roof, floor or panel. */
export interface EntryGeo {
  x: number
  y: number
  z: number
  w: number
  d: number
}

/** A 0U channel's line (mm). */
export interface ChannelGeo {
  x: number
  y: number
  z0: number
  z1: number
}

/** One shown pathway of a rack as the scene carries it (api.scene_geo
 * pathways_geo). */
export interface ScenePathway {
  key: string
  id: string | null
  /** From the rack's kit (its model draws it), the frame's defaults, its
   * type or the rack itself. */
  source: "kit" | "default" | "type" | "manual"
  kind: "vertical" | "horizontal" | "entry" | "channel"
  subkind: string
  side: "left" | "right" | ""
  face: "front" | "rear" | "full" | ""
  surface: "top" | "bottom" | "side" | ""
  u_from: number | null
  u_to: number | null
  inner_w_mm: number | null
  inner_d_mm: number | null
  fill_limit_pct: number
  label: string
  addon: boolean
  geo: ManagerGeo | EntryGeo | ChannelGeo
}

/** One end of a way in its rack: the device and port it starts or ends at. */
export interface SceneWayEnd {
  end: "A" | "B"
  device: string
  port: string
  kind: string
}

/** A stored cable way through a rack (api.scene_geo ways_geo). */
export interface SceneWay {
  id: string
  cable_id: string
  label: string
  color: string
  type: string
  outer_diameter_mm: number | null
  end: "A" | "B" | "AB"
  state: "recorded" | "proposed"
  source: "auto" | "manual"
  exit: "port" | "top" | "bottom" | "side" | ""
  hops: {
    key: string
    kind: string
    enter_u: number | null
    leave_u: number | null
  }[]
  length_mm: number | null
  ends: SceneWayEnd[]
}

export const isManager = (
  p: ScenePathway
): p is ScenePathway & { geo: ManagerGeo } =>
  p.kind === "vertical" || p.kind === "horizontal"

/** Rack millimetres → the rack group's frame (m), for a rack `depthM` deep. */
export function rackLocal(
  depthM: number,
  x: number,
  y: number,
  z: number
): Vec3 {
  return [-x / 1000, z / 1000, -depthM / 2 + y / 1000]
}

// ── cable sizes ─────────────────────────────────────────────────────────────

/** A cable's outer diameter (mm) when it records none: what its type is
 * like (Cat6 6.1 mm, a fibre zip cord 3 mm, a DAC 4.5 mm, a power cord
 * 8 mm). Indicative - phase 4's fill maths reads the cable's own. */
export function wayDiameterMm(
  type: string | null | undefined,
  outer?: number | null
): number {
  if (outer != null && outer > 0) return outer
  const t = (type ?? "").toLowerCase()
  if (t.includes("power")) return 8
  if (/smf|mmf|fib|os[12]|om[1-5]/.test(t)) return 3
  if (t.includes("aoc")) return 3
  if (t.includes("dac") || t.includes("twinax")) return 4.5
  if (t.includes("cat6a") || t.includes("cat7") || t.includes("cat8"))
    return 7.5
  if (t.includes("cat5")) return 5.5
  if (t.includes("stack")) return 6
  return 6.1
}

// ── lanes in a manager ──────────────────────────────────────────────────────

/** A cable's lane in a manager: its offset from the inner centre (mm) -
 * `u` across (rack x), `v` front to back (rack y) - and `layer` > 0 when
 * the manager is fuller than its cross-section holds (lanes then repeat;
 * the fill overlay shows it red). */
export interface Lane {
  u: number
  v: number
  layer: number
}

/**
 * The lanes of the cables in one manager, deterministic: ordered by cable
 * id, laid in rows of the manager's inner width, one cable diameter (the
 * widest of them, and a hair) apart, the first row against the wall away
 * from the side cables come in by (`open`), so later cables do not cross
 * the earlier ones to reach their lane. Every lane lies inside the inner
 * cross-section; no two lanes of one layer overlap.
 */
export function managerLanes(
  innerW: number,
  innerD: number,
  open: ManagerGeo["open"],
  cables: readonly { id: string; dia: number }[]
): Map<string, Lane> {
  const out = new Map<string, Lane>()
  if (!cables.length) return out
  const w = Math.max(innerW, 1)
  const d = Math.max(innerD, 1)
  const pitch = Math.max(...cables.map((c) => c.dia)) + 0.4
  const cols = Math.max(1, Math.floor(w / pitch))
  const rows = Math.max(1, Math.floor(d / pitch))
  const per = cols * rows
  // From the wall opposite the open side, toward it.
  const back = open === "rear" ? -1 : 1
  const fromOuter = open === "inner" ? 1 : open === "outer" ? -1 : 0
  const ordered = [...cables].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  )
  const spanU = Math.min(w, cols * pitch)
  const spanV = Math.min(d, rows * pitch)
  ordered.forEach((c, k) => {
    const layer = Math.floor(k / per)
    const i = k % per
    let col: number
    let row: number
    if (fromOuter !== 0) {
      // Entering from a side: fill columns from the far side in.
      row = i % rows
      col = Math.floor(i / rows)
    } else {
      col = i % cols
      row = Math.floor(i / cols)
    }
    const u0 = -spanU / 2 + pitch / 2 + col * pitch
    const v0 = spanV / 2 - pitch / 2 - row * pitch
    // A layer past the first sits half a pitch over, so overfull reads.
    const shift = layer > 0 ? (pitch / 2) * (layer % 2) : 0
    const u = fromOuter !== 0 ? -fromOuter * u0 : u0
    out.set(c.id, {
      u: clamp(u + shift, -w / 2 + c.dia / 2, w / 2 - c.dia / 2),
      v: clamp(back * v0, -d / 2 + c.dia / 2, d / 2 - c.dia / 2),
      layer,
    })
  })
  return out
}

function clamp(v: number, lo: number, hi: number): number {
  return lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v))
}

/** A manager's inner size (mm): its recorded one, else its box less its
 * walls. */
export function innerSize(p: ScenePathway & { geo: ManagerGeo }): {
  w: number
  d: number
} {
  const g = p.geo
  const wall = g.wall
  return {
    w: p.inner_w_mm ?? Math.max(1, g.x1 - g.x0 - 2 * wall),
    d: p.inner_d_mm ?? Math.max(1, g.y1 - g.y0 - 2 * wall),
  }
}

// ── a way's run ─────────────────────────────────────────────────────────────

/** A port's anchor in the rack's frame (m): the port and the end of its
 * stub out of the face (cable-trace-3d portLocal, or a cord's lead). */
export interface PortAnchor {
  p: Vec3
  stub: Vec3
}

/** How far a way leaves its entry before the room's run takes over (m). */
export const ENTRY_OUT_M = 0.05
/** How far under the roof (or over the floor) a way crosses to its entry. */
export const UNDER_ROOF_M = 0.025

export interface WayRunInput {
  depthM: number
  /** The rack's height (its roof's top, m). */
  heightM: number
  /** Unit 1's bottom above the floor (m). */
  baseM: number
  /** The top of its top unit (m): a way crosses to a roof entry between
   * it and the roof. */
  topUnitM: number
  pathways: ReadonlyMap<string, ScenePathway>
  way: Pick<SceneWay, "cable_id" | "hops" | "exit">
  /** The cable's lane in each manager it runs in (`managerLanes`). */
  lanes: ReadonlyMap<string, ReadonlyMap<string, Lane>>
  /** The port the way starts at, and the far port of a way that ends at
   * one (both ends in this rack). */
  start: PortAnchor
  far?: PortAnchor | null
}

export interface WayRun {
  /** The run in the rack's frame (m), port to far port or out of the rack. */
  points: Vec3[]
  /** Where it leaves the rack - past its entry, or over the top of an open
   * frame's manager - for the room's run to carry on from (rack frame). */
  exit: Vec3 | null
  /** The managers it runs in, with the span (rack frame y, m) in each. */
  spans: { key: string; y0: number; y1: number; at: [number, number] }[]
}

/**
 * The run of one way through its rack: out of the port's stub, along the
 * face to its first manager (through a horizontal manager at its unit when
 * the way names one), into its lane there at the port's height, along the
 * manager, then to the far port or up (down) to the entry it leaves by -
 * under the roof (over the floor) to the opening, through it and a little
 * past. Runs square: every leg changes one or two axes, beside the gear,
 * not through it. A hop whose pathway the rack no longer shows is skipped.
 */
export function wayRun(input: WayRunInput): WayRun {
  const { depthM, heightM, baseM, topUnitM, pathways, way, lanes, start, far } =
    input
  const L = (x: number, y: number, z: number) => rackLocal(depthM, x, y, z)
  const pts: Vec3[] = [start.p, start.stub]
  const spans: WayRun["spans"] = []
  // The depth (rack frame z) the run moves across the face at.
  const faceZ = start.stub[2]
  let cur: Vec3 = start.stub
  let exitAt: Vec3 | null = null
  const laneOf = (key: string): Lane =>
    lanes.get(key)?.get(way.cable_id) ?? { u: 0, v: 0, layer: 0 }
  for (let i = 0; i < way.hops.length; i++) {
    const hop = way.hops[i]
    const p = pathways.get(hop.key)
    if (!p) continue
    if (p.kind === "horizontal") {
      const g = p.geo as ManagerGeo
      const [, hy, hz] = L(0, g.cy, (g.z0 + g.z1) / 2)
      // Out to the manager's channel at its unit, beside the port.
      pts.push([cur[0], hy, cur[2]], [cur[0], hy, hz])
      cur = [cur[0], hy, hz]
      continue
    }
    if (p.kind === "vertical") {
      const g = p.geo as ManagerGeo
      const lane = laneOf(p.key)
      const [lx, , lz] = L(g.cx + lane.u, g.cy + lane.v, 0)
      const yLeave = leaveY(input, i, cur[1])
      if (g.open === "ends") {
        // A closed channel: in at its end, beside it until then.
        const endY = yLeave >= cur[1] ? g.z1 / 1000 : g.z0 / 1000
        pts.push([lx, cur[1], cur[2]], [lx, endY, cur[2]], [lx, endY, lz])
      } else {
        // Along the face to the manager, then back into its lane.
        pts.push([lx, cur[1], cur[2]], [lx, cur[1], lz])
      }
      pts.push([lx, yLeave, lz])
      spans.push({
        key: p.key,
        y0: Math.min(cur[1], yLeave),
        y1: Math.max(cur[1], yLeave),
        at: [lx, lz],
      })
      cur = [lx, yLeave, lz]
      continue
    }
    if (p.kind === "channel") {
      const g = p.geo as ChannelGeo
      const [cx, , cz] = L(g.x, g.y, 0)
      if (far && i === way.hops.length - 1) continue
      // A PDU's own cord: along its channel.
      const y = leaveY(input, i, cur[1])
      pts.push([cx, cur[1], faceZ], [cx, cur[1], cz], [cx, y, cz])
      cur = [cx, y, cz]
      continue
    }
    {
      const g = p.geo as EntryGeo
      const lane = laneOf(p.key)
      const [ex, , ez] = L(g.x + lane.u, g.y + lane.v, 0)
      const top = p.surface !== "bottom" && p.surface !== "side"
      if (p.surface === "side") {
        const [, ey] = L(0, 0, g.z)
        pts.push([cur[0], ey, cur[2]], [ex, ey, ez])
        exitAt = [ex + Math.sign(ex) * ENTRY_OUT_M, ey, ez]
      } else {
        const under = top ? underRoof(topUnitM, heightM) : baseM / 2
        const out = top ? heightM + ENTRY_OUT_M : -ENTRY_OUT_M
        pts.push([cur[0], under, cur[2]], [ex, under, ez])
        exitAt = [ex, out, ez]
      }
      pts.push(exitAt)
      cur = exitAt
      continue
    }
  }
  if (way.exit === "port" && far) {
    if (spans.length) {
      // Out of the manager at the far port's height, to its face, along it.
      pts.push(
        [cur[0], far.stub[1], cur[2]],
        [cur[0], far.stub[1], far.stub[2]],
        far.stub,
        far.p
      )
    } else {
      // No manager (a cord to a PDU in its channel, a patch through a
      // horizontal manager): across at the port's height to beside the far
      // port, then up or down there - beside the gear, never through it.
      pts.push(
        [far.stub[0], cur[1], cur[2]],
        [far.stub[0], far.stub[1], cur[2]],
        far.stub,
        far.p
      )
    }
  } else if (!exitAt && (way.exit === "top" || way.exit === "bottom")) {
    // An open frame: out over the top (under the bottom) of the manager.
    exitAt = [
      cur[0],
      way.exit === "top" ? heightM + ENTRY_OUT_M : -ENTRY_OUT_M,
      cur[2],
    ]
    pts.push(exitAt)
  }
  return { points: squared(pts), exit: exitAt, spans }
}

/** The height (rack frame y, m) a way leaves hop `i` at: the far port's,
 * the next hop's (an entry: the manager's end toward it), else the hop's
 * own `leave_u` end of the manager. */
function leaveY(input: WayRunInput, i: number, curY: number): number {
  const { way, pathways, far, heightM } = input
  const p = pathways.get(way.hops[i].key)
  const next = way.hops.slice(i + 1).find((h) => pathways.has(h.key))
  const g = p?.geo as ManagerGeo | ChannelGeo | undefined
  const z0 = g ? g.z0 / 1000 : 0
  const z1 = g ? g.z1 / 1000 : heightM
  if (next) {
    const n = pathways.get(next.key)!
    if (n.kind === "entry") return n.surface === "bottom" ? z0 : z1
    if (n.kind === "horizontal") {
      const ng = n.geo as ManagerGeo
      return (ng.z0 + ng.z1) / 2000
    }
  }
  if (far && way.exit === "port") return far.stub[1]
  if (way.exit === "top") return z1
  if (way.exit === "bottom") return z0
  return curY
}

/** The height a way crosses under the roof at (m): between the top unit and
 * the roof's underside, clear of both. */
export function underRoof(topUnitM: number, heightM: number): number {
  const roof = heightM - 0.005
  return roof - topUnitM > 0.006
    ? (topUnitM + roof) / 2
    : heightM - UNDER_ROOF_M
}

/** `points` without repeats and with collinear inner points dropped. */
export function squared(points: readonly Vec3[]): Vec3[] {
  const out: Vec3[] = []
  for (const p of points) {
    const last = out[out.length - 1]
    if (
      out.length > 0 &&
      Math.hypot(p[0] - last[0], p[1] - last[1], p[2] - last[2]) < 1e-5
    )
      continue
    if (out.length >= 2) {
      const a = out[out.length - 2]
      const b = out[out.length - 1]
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
      const v = [p[0] - b[0], p[1] - b[1], p[2] - b[2]]
      const cross = Math.hypot(
        u[1] * v[2] - u[2] * v[1],
        u[2] * v[0] - u[0] * v[2],
        u[0] * v[1] - u[1] * v[0]
      )
      const dot = u[0] * v[0] + u[1] * v[1] + u[2] * v[2]
      if (cross < 1e-9 && dot > 0) out.pop()
    }
    out.push([...p] as Vec3)
  }
  return out
}

// ── the lanes of a rack ─────────────────────────────────────────────────────

/** Every manager's and entry's lanes for the ways of one rack. */
export function rackLanes(
  pathways: ReadonlyMap<string, ScenePathway>,
  ways: readonly Pick<
    SceneWay,
    "cable_id" | "hops" | "type" | "outer_diameter_mm"
  >[]
): Map<string, Map<string, Lane>> {
  const members = new Map<string, { id: string; dia: number }[]>()
  for (const w of ways) {
    const dia = wayDiameterMm(w.type, w.outer_diameter_mm)
    for (const k of new Set(w.hops.map((h) => h.key))) {
      const p = pathways.get(k)
      if (!p || (p.kind !== "vertical" && p.kind !== "entry")) continue
      let m = members.get(k)
      if (!m) members.set(k, (m = []))
      m.push({ id: w.cable_id, dia })
    }
  }
  const out = new Map<string, Map<string, Lane>>()
  for (const [k, cables] of members) {
    const p = pathways.get(k)!
    if (p.kind === "vertical") {
      const { w, d } = innerSize(p as ScenePathway & { geo: ManagerGeo })
      out.set(k, managerLanes(w, d, (p.geo as ManagerGeo).open, cables))
    } else {
      const g = p.geo as EntryGeo
      // Through an opening: spread across it, a margin from its edges.
      out.set(k, managerLanes(g.w * 0.8, g.d * 0.7, "front", cables))
    }
  }
  return out
}

// ── where a way leaves its rack, for the room's run ────────────────────────

/** A rack's frame for `wayRun` (m): its depth, height, unit 1 and top unit. */
export function rackFrameM(rack: SceneRack): {
  depthM: number
  heightM: number
  baseM: number
  topUnitM: number
} {
  const { depth, height } = rackFootprintM(rack)
  const baseM = rackBaseM(rack)
  return {
    depthM: depth,
    heightM: height,
    baseM,
    topUnitM: baseM + rack.u_height * mm(PANEL_MM.uPitch),
  }
}

/**
 * Where each way of `rack` that leaves it (by an entry, or over an open
 * frame's manager) comes out, in the rack's frame (m), by cable and end
 * (`${cable}|A`): the room's run of that cable starts there instead of at
 * the port, so the cable reads as one, rack → tray → rack. Independent of
 * the port: an entry's lane, or the manager's.
 */
export function rackWayExits(rack: SceneRack): Map<string, Vec3> {
  const out = new Map<string, Vec3>()
  const ways = rack.ways ?? []
  if (!ways.length) return out
  const pathways = new Map((rack.pathways ?? []).map((p) => [p.key, p]))
  const lanes = rackLanes(pathways, ways)
  const frame = rackFrameM(rack)
  const nowhere: PortAnchor = { p: [0, 0, 0], stub: [0, 0, 0] }
  for (const way of ways) {
    if (way.end === "AB" || way.exit === "port" || !way.exit) continue
    const run = wayRun({ ...frame, pathways, way, lanes, start: nowhere })
    if (run.exit) out.set(`${way.cable_id}|${way.end}`, run.exit)
  }
  return out
}

// ── from afar: bundles ──────────────────────────────────────────────────────

/** What a rack's ways layer draws at a tier: each cable up close, one
 * bundle per manager further off (cheap, and all a rack reads as there). */
export function wayLod(tier: Tier): "cables" | "bundles" {
  return tier === "detail" ? "cables" : "bundles"
}

/** One manager's cables as one tube: its axis at the manager's inner
 * centre (rack frame), over the heights they run (m), as thick as their
 * cross-sections together and never wider than the manager's inside. */
export interface Bundle {
  key: string
  at: [number, number]
  y0: number
  y1: number
  radius: number
  color: string
  count: number
}

export function bundles(
  depthM: number,
  pathways: ReadonlyMap<string, ScenePathway>,
  runs: readonly {
    spans: WayRun["spans"]
    dia: number
    color: string
  }[]
): Bundle[] {
  const by = new Map<
    string,
    {
      y0: number
      y1: number
      area: number
      colors: Map<string, number>
      n: number
    }
  >()
  for (const r of runs) {
    for (const s of r.spans) {
      let b = by.get(s.key)
      if (!b)
        by.set(
          s.key,
          (b = { y0: s.y0, y1: s.y1, area: 0, colors: new Map(), n: 0 })
        )
      b.y0 = Math.min(b.y0, s.y0)
      b.y1 = Math.max(b.y1, s.y1)
      b.area += (r.dia * r.dia) / 4
      b.colors.set(r.color, (b.colors.get(r.color) ?? 0) + 1)
      b.n += 1
    }
  }
  const out: Bundle[] = []
  for (const [key, b] of [...by].sort((a, c) => (a[0] < c[0] ? -1 : 1))) {
    const p = pathways.get(key)
    if (!p || p.kind !== "vertical") continue
    const g = p.geo as ManagerGeo
    const { w, d } = innerSize(p as ScenePathway & { geo: ManagerGeo })
    // r² = Σ (d/2)²: the cables' area together, packed loosely (×1.2).
    const r = Math.min(Math.sqrt(b.area * 1.2), Math.min(w, d) / 2) / 1000
    const [x, , z] = rackLocal(depthM, g.cx, g.cy, 0)
    const color = [...b.colors].sort(
      (a, c) => c[1] - a[1] || (a[0] < c[0] ? -1 : 1)
    )[0][0]
    out.push({
      key,
      at: [x, z],
      y0: b.y0,
      y1: b.y1,
      radius: Math.max(r, 0.002),
      color,
      count: b.n,
    })
  }
  return out
}

// ── fill, indicative ────────────────────────────────────────────────────────

/** How full a manager or an entry is, indicatively: its cables' cross-
 * sections over its usable area (inner size × its fill limit, 40 % by
 * default). 1 is at the limit. Phase 4 counts it properly. */
export function fillShare(
  innerW: number,
  innerD: number,
  limitPct: number,
  dias: readonly number[]
): number {
  const usable = Math.max(innerW * innerD, 1) * (Math.max(limitPct, 1) / 100)
  const used = dias.reduce((s, d) => s + (Math.PI * d * d) / 4, 0)
  return used / usable
}

/** Each manager's and entry's indicative fill colour (`fillShare`), by
 * key, from the recorded ways through it (a proposed one is not counted). */
export function pathwayFills(
  pathways: ReadonlyMap<string, ScenePathway>,
  ways: readonly Pick<
    SceneWay,
    "hops" | "state" | "type" | "outer_diameter_mm"
  >[]
): Map<string, string> {
  const dias = new Map<string, number[]>()
  for (const w of ways) {
    if (w.state !== "recorded") continue
    const dia = wayDiameterMm(w.type, w.outer_diameter_mm)
    for (const k of new Set(w.hops.map((h) => h.key))) {
      const list = dias.get(k) ?? []
      list.push(dia)
      dias.set(k, list)
    }
  }
  const out = new Map<string, string>()
  for (const p of pathways.values()) {
    if (p.kind !== "vertical" && p.kind !== "entry") continue
    const size =
      p.kind === "vertical"
        ? innerSize(p as ScenePathway & { geo: ManagerGeo })
        : { w: (p.geo as EntryGeo).w, d: (p.geo as EntryGeo).d }
    out.set(
      p.key,
      fillColor(
        fillShare(size.w, size.d, p.fill_limit_pct, dias.get(p.key) ?? [])
      )
    )
  }
  return out
}

/** The fill overlay's colour for a share of the limit: green under 70 %,
 * amber to the limit, red past it. */
export function fillColor(share: number): string {
  if (share >= 1) return "#dc2626"
  if (share >= 0.7) return "#d97706"
  return "#16a34a"
}
