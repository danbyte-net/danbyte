import type { FloorPlanTile, FloorPlanWall } from "@/lib/api"
import { slabOutline } from "@/components/floorplan3d/building-math"
import type { SceneWall } from "@/components/floorplan3d/world"

import { tileIsZone, tileName } from "./canvas-geometry"
import type { PlanRoom } from "./plan-lod"
import { rowHead } from "./plan-rows"
import type { TileRow } from "./plan-rows"
import { areaIcon, areaName, boxCorners, polygonCentroid } from "./shapes"
import type { AreaShape, Pt } from "./shapes"

// Detail by zoom: the 2D plan draws one clear picture per zoom instead of
// everything at every zoom.
//
//   overview  the floor or the building on screen: rooms only - a flat
//             block each, one centred label with a line of facts.
//   room      a hall fills much of the screen: rows as bars, icon tiles,
//             no callouts but the hovered or selected one's.
//   detail    racks big enough to read: tiles with short names.
//
// The level follows the plan's size on screen (px per metre), with a
// wider threshold back so a zoom about one does not flicker. Display ›
// Detail: Always full draws everything at every zoom, as before. Paper
// (plan-svg.ts) never asks: it prints the detail level at its scale.
//
// Units: cells unless said; px on screen.

export const DETAIL_MODES = ["auto", "full"] as const
export type DetailMode = (typeof DETAIL_MODES)[number]

/** The stored choice (`plan.state.detail`): Auto unless the plan chose
 * Always full. */
export function readDetailMode(v: unknown): DetailMode {
  return v === "full" ? "full" : "auto"
}

export type DetailLevel = "overview" | "room" | "detail"

/** Over this (px per metre) the overview opens into rooms; it folds back
 * under ROOM_EXIT. */
export const ROOM_ENTER_PX_PER_M = 11
export const ROOM_EXIT_PX_PER_M = 9
/** Over this the racks are big enough to read; back under DETAIL_EXIT. */
export const DETAIL_ENTER_PX_PER_M = 60
export const DETAIL_EXIT_PX_PER_M = 50

/** The plan's metre on screen (px). */
export function pxPerMetre(pxPerCell: number, cellMm: number): number {
  return cellMm > 0 ? (pxPerCell * 1000) / cellMm : pxPerCell
}

/** The level at `ppm` px per metre, `prev` the level shown last. */
export function detailLevel(
  ppm: number,
  prev: DetailLevel | null = null
): DetailLevel {
  const detailAt =
    prev === "detail" ? DETAIL_EXIT_PX_PER_M : DETAIL_ENTER_PX_PER_M
  const roomAt = prev === "overview" ? ROOM_ENTER_PX_PER_M : ROOM_EXIT_PX_PER_M
  if (ppm >= detailAt) return "detail"
  if (ppm >= roomAt) return "room"
  return "overview"
}

/** What the plan draws at a level. */
export interface LevelShows {
  level: DetailLevel | "full"
  /** Placed tiles (the selection and what is pointed at always draw). */
  tiles: boolean
  /** Names in and by the tiles: all, or the hovered and selected only. */
  tileNames: "all" | "focus"
  /** A rack's name less what its row says ("DH5-A01" → "A01"). */
  shortNames: boolean
  /** A rack's capacity bar: always, or on the hovered and selected. */
  capacity: "all" | "focus"
  /** The front edge faint. */
  quietMarks: boolean
  /** Zone tiles (aisles): as they are, a light wash, or not at all. */
  zones: "full" | "light" | "none"
  callouts: "all" | "focus" | "none"
  /** Rows from afar as bars, their names along them. */
  rows: boolean
  /** A room's rows folded into a plate on it (else its label says it). */
  hallPlates: boolean
  /** Camera cones: all, the hovered or selected camera's, none. */
  cones: "all" | "focus" | "none"
  coverage: boolean
  /** An area type's pattern: as drawn, fine and faint, or left out. */
  pattern: "full" | "fine" | "none"
  trays: boolean
  cables: boolean
  /** Door leaves and swings. */
  doors: boolean
  raised: boolean
  /** Area names: as always, sorted (none over another, none past its
   * room), or none - the room labels say them. */
  areaNames: "plain" | "sorted" | "none"
  /** Centred room labels with their facts. */
  roomLabels: boolean
  /** The base map blanked inside the building. */
  maskMap: boolean
}

/** Everything at every zoom: the plan as it was before Detail by zoom. */
export const FULL_SHOWS: LevelShows = {
  level: "full",
  tiles: true,
  tileNames: "all",
  shortNames: false,
  capacity: "all",
  quietMarks: false,
  zones: "full",
  callouts: "all",
  rows: true,
  hallPlates: true,
  cones: "all",
  coverage: true,
  pattern: "full",
  trays: true,
  cables: true,
  doors: true,
  raised: true,
  areaNames: "plain",
  roomLabels: false,
  maskMap: false,
}

/** What `level` shows. `capacityColour`: Colour by is a capacity measure
 * (the bars are what the plan is about then); `coverage`: Camera coverage
 * is on (every cone matters). */
export function levelShows(
  level: DetailLevel,
  mode: DetailMode,
  {
    capacityColour = false,
    coverage = false,
  }: { capacityColour?: boolean; coverage?: boolean } = {}
): LevelShows {
  if (mode === "full") return FULL_SHOWS
  const cones = coverage ? "all" : "focus"
  if (level === "overview")
    return {
      level,
      tiles: false,
      tileNames: "focus",
      shortNames: false,
      capacity: "focus",
      quietMarks: true,
      zones: "none",
      callouts: "none",
      rows: false,
      hallPlates: false,
      cones: "none",
      coverage: false,
      pattern: "none",
      trays: false,
      cables: false,
      doors: false,
      raised: false,
      areaNames: "none",
      roomLabels: true,
      maskMap: true,
    }
  if (level === "room")
    return {
      level,
      tiles: true,
      tileNames: "focus",
      shortNames: false,
      capacity: capacityColour ? "all" : "focus",
      quietMarks: true,
      zones: "light",
      callouts: "focus",
      rows: true,
      hallPlates: false,
      cones,
      coverage,
      pattern: "none",
      trays: true,
      cables: true,
      doors: true,
      raised: true,
      areaNames: "sorted",
      roomLabels: false,
      maskMap: true,
    }
  return {
    level,
    tiles: true,
    tileNames: "all",
    shortNames: true,
    capacity: capacityColour ? "all" : "focus",
    quietMarks: true,
    zones: "light",
    callouts: "all",
    rows: true,
    hallPlates: false,
    cones,
    coverage,
    pattern: "fine",
    trays: true,
    cables: true,
    doors: true,
    raised: true,
    areaNames: "sorted",
    roomLabels: false,
    maskMap: true,
  }
}

// ── Short names ───────────────────────────────────────────────────────

/** Each row member's name less what the row's label already says - the
 * head its names share before the row letters ("DH5-A01" → "A01"). A name
 * that would come out empty keeps its own. */
export function shortTileNames(
  rows: readonly Pick<TileRow, "members" | "names">[]
): Map<string, string> {
  const out = new Map<string, string>()
  for (const r of rows) {
    const head = rowHead(r.names)
    if (!head) continue
    r.members.forEach((id, i) => {
      const n = r.names[i] ?? ""
      const rest = n.startsWith(head) ? n.slice(head.length) : ""
      if (rest) out.set(id, rest)
    })
  }
  return out
}

// ── Room facts ─────────────────────────────────────────────────────────

/** A rack's units: used of its height. */
export interface RackFill {
  used: number
  total: number
}

export interface RoomFacts {
  /** "72 racks · 61% full", "3 UPS", "" with nothing in it. */
  text: string
  /** The worst monitoring state in it that alarms, and how many tiles. */
  alarm: { check: string; count: number } | null
}

const ALARM_RANK: Record<string, number> = { down: 3, stale: 2, degraded: 1 }
const ALARM_WORD: Record<string, string> = {
  down: "down",
  stale: "stale",
  degraded: "degraded",
}
const KIND_WORD: Record<string, [string, string]> = {
  rack: ["rack", "racks"],
  cabinet: ["cabinet", "cabinets"],
  device: ["device", "devices"],
}
// Words that do not take an "s": "3 switchgear", "14 fire suppression".
const MASS = /(ion|ment|gear|ing|ware|s|x|ch|sh)$/i

/** "3 UPS", "6 cooling units", "1 switchgear": a type's name counted. An
 * acronym keeps its case. */
export function countOf(name: string, n: number): string {
  const acronym = /^[A-Z0-9]{2,6}$/.test(name)
  const word = acronym ? name : name.toLowerCase()
  if (n === 1 || acronym || MASS.test(word)) return `${n} ${word}`
  return `${n} ${word}s`
}

/** Each room's facts: what stands in it (its centre inside the room, a
 * room's inner rooms included) - its racks and how full, else its most
 * numerous kinds - and its worst alarm. Zones are left out; a lone tile
 * that names the room ("Stairs" in "Stair N") says nothing new. */
export function roomFacts(
  rooms: readonly PlanRoom[],
  tiles: readonly FloorPlanTile[],
  {
    fillOf,
    checkOf,
  }: {
    fillOf?: (t: FloorPlanTile) => RackFill | null | undefined
    checkOf?: (t: FloorPlanTile) => string | null | undefined
  } = {}
): Map<string, RoomFacts> {
  const placed = tiles
    .filter((t) => !tileIsZone(t))
    .map((t) => ({ t, c: [t.x + t.width / 2, t.y + t.height / 2] as Pt }))
  const out = new Map<string, RoomFacts>()
  for (const room of rooms) {
    let racks = 0
    let used = 0
    let total = 0
    const counts = new Map<string, number>()
    let alarm: RoomFacts["alarm"] = null
    for (const { t, c } of placed) {
      if (!room.contains(c)) continue
      const check = checkOf?.(t)
      const rank = check ? (ALARM_RANK[check] ?? 0) : 0
      if (rank) {
        if (!alarm || rank > ALARM_RANK[alarm.check])
          alarm = { check: check!, count: 1 }
        else if (alarm.check === check) alarm.count++
      }
      const kind = t.linked?.kind
      if (kind === "rack") {
        racks++
        const f = fillOf?.(t)
        if (f && f.total > 0) {
          used += f.used
          total += f.total
        }
        continue
      }
      // Unlinked, its type says what it is ("Rack" counts as a rack).
      const key = kind
        ? `kind:${kind}`
        : t.tile_type?.name
          ? `type:${t.tile_type.name}`
          : ""
      if (!key) continue
      if (key.toLowerCase() === "type:rack") {
        racks++
        continue
      }
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    let text = ""
    if (racks) {
      text = `${racks} ${racks === 1 ? "rack" : "racks"}`
      if (total > 0) text += ` · ${Math.round((used / total) * 100)}% full`
    } else {
      const lower = room.name.toLowerCase()
      const parts = [...counts]
        .filter(([key, n]) => {
          if (n > 1 || !key.startsWith("type:")) return true
          const stem = key.slice(5).toLowerCase().slice(0, 4)
          return !lower.includes(stem)
        })
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, 2)
        .map(([key, n]) => {
          if (key.startsWith("kind:")) {
            const w = KIND_WORD[key.slice(5)] ?? ["object", "objects"]
            return `${n} ${n === 1 ? w[0] : w[1]}`
          }
          return countOf(key.slice(5), n)
        })
      text = parts.join(" · ")
    }
    out.set(room.id, { text, alarm })
  }
  return out
}

/** "2 down", "1 degraded": an alarm as its label's badge says it. */
export function alarmText(a: { check: string; count: number }): string {
  return `${a.count} ${ALARM_WORD[a.check] ?? a.check}`
}

// ── Room labels (overview) ─────────────────────────────────────────────

/** A room label's type (px). */
export const ROOM_NAME_PX = 12
export const ROOM_FACT_PX = 10.5
const NAME_EM = 0.6
const FACT_EM = 0.56
const BADGE_PX = 10
const LABEL_PAD = 4
const LABEL_GAP = 6

/** A room label as drawn: centred on `at` (cells), turned by `angle`
 * (degrees, upright), its size (px). */
export interface RoomLabel {
  id: string
  at: Pt
  angle: number
  name: string
  /** The facts line, "" when it did not fit or there are none. */
  facts: string
  badge: string
  check: string | null
  /** A part of a room (a cage in its hall, a fit-out zone): its name
   * reads under the room's. */
  minor: boolean
  w: number
  h: number
}

/** An area round rooms that cover this share of it is an outline - a
 * building's, a site's - named by its rooms, not over them. */
const OUTLINE_SHARE = 0.4

/** Each room's parent (the smallest room round its middle), and the
 * outlines: rooms round two or more rooms that cover much of them. */
export function roomNesting(rooms: readonly PlanRoom[]): {
  parentOf: Map<string, PlanRoom>
  outlines: Set<string>
} {
  const parentOf = new Map<string, PlanRoom>()
  // Smallest first, so the first room round a room is its parent.
  const bySize = [...rooms].sort((a, b) => a.size - b.size)
  for (const r of bySize) {
    const p = bySize.find(
      (q) => q.id !== r.id && q.size > r.size && q.contains(r.at)
    )
    if (p) parentOf.set(r.id, p)
  }
  const kids = new Map<string, { n: number; size: number }>()
  for (const [id, p] of parentOf) {
    const r = rooms.find((x) => x.id === id)!
    const k = kids.get(p.id) ?? { n: 0, size: 0 }
    kids.set(p.id, { n: k.n + 1, size: k.size + r.size })
  }
  const outlines = new Set<string>()
  for (const r of rooms) {
    const k = kids.get(r.id)
    if (k && k.n >= 2 && k.size >= r.size * OUTLINE_SHARE) outlines.add(r.id)
  }
  return { parentOf, outlines }
}

/** A room label's size (px) with and without its facts line. */
export function roomLabelSize(
  name: string,
  facts: string,
  badge: string
): { w: number; h: number } {
  const badgeW = badge ? badge.length * BADGE_PX * 0.6 + 10 + 5 : 0
  const nameW = name.length * ROOM_NAME_PX * NAME_EM + badgeW
  const factW = facts.length * ROOM_FACT_PX * FACT_EM
  return {
    w: Math.max(nameW, factW) + LABEL_PAD * 2,
    h: ROOM_NAME_PX * 1.25 + (facts ? ROOM_FACT_PX * 1.35 : 0) + LABEL_PAD,
  }
}

/** A text's turn (degrees) read upright: in (-90, 90]. */
export function upright(deg: number): number {
  let d = ((deg % 180) + 180) % 180
  if (d > 90) d -= 180
  return Math.abs(d) < 1e-9 ? 0 : d
}

/** The corners (cells) of a box `w` x `h` centred on `at`, turned. */
function turnedBox(at: Pt, w: number, h: number, deg: number): Pt[] {
  const r = (deg * Math.PI) / 180
  const c = Math.cos(r)
  const s = Math.sin(r)
  return (
    [
      [-w / 2, -h / 2],
      [w / 2, -h / 2],
      [w / 2, h / 2],
      [-w / 2, h / 2],
    ] as Pt[]
  ).map(([x, y]) => [at[0] + x * c - y * s, at[1] + x * s + y * c])
}

/**
 * The overview's room labels at `scale` px per cell: each named room's
 * name, centred, with its facts line under it where that fits too and its
 * alarm's badge by the name - upright, else along the room when only that
 * fits (a long narrow plant room). A room too small for its name gets
 * none (its name shows on hover); of two that would touch the smaller
 * gives way. Deterministic.
 */
export function placeRoomLabels(
  areas: readonly AreaShape[],
  rooms: readonly PlanRoom[],
  facts: ReadonlyMap<string, RoomFacts>,
  scale: number
): RoomLabel[] {
  if (!(scale > 0)) return []
  const roomById = new Map(rooms.map((r) => [r.id, r]))
  const order = areas
    .filter((a) => a.show_name && areaName(a) && roomById.has(a.id))
    .map((a) => roomById.get(a.id)!)
    .sort((a, b) => b.size - a.size || (a.id < b.id ? -1 : 1))
  const kept: { label: RoomLabel; quad: Pt[] }[] = []
  const { parentOf, outlines } = roomNesting(rooms)
  const pad = LABEL_GAP / 2 / scale
  for (const room of order) {
    // An outline round rooms is named by its rooms.
    if (outlines.has(room.id)) continue
    const parent = parentOf.get(room.id)
    const f = facts.get(room.id)
    const alarm = f?.alarm ?? null
    const badge = alarm ? alarmText(alarm) : ""
    const tries: [string, string][] = [
      ...(f?.text ? ([[f.text, badge]] as [string, string][]) : []),
      ["", badge],
      ...(badge ? ([["", ""]] as [string, string][]) : []),
    ]
    const angles = [
      ...new Set([0, upright(room.rotation), upright(room.rotation + 90)]),
    ]
    let placed = false
    for (const [line, b] of tries) {
      const size = roomLabelSize(room.name, line, b)
      const w = size.w / scale
      const h = size.h / scale
      for (const angle of angles) {
        const box = turnedBox(room.at, w, h, angle)
        if (!box.every((p) => room.contains(p))) continue
        // Clear of the others by a gap: the box grown by half of it.
        const quad = turnedBox(room.at, w + pad * 2, h + pad * 2, angle)
        if (kept.some((k) => quadsOverlap(k.quad, quad))) continue
        kept.push({
          quad,
          label: {
            id: room.id,
            at: room.at,
            angle,
            name: room.name,
            facts: line,
            badge: b,
            check: b ? alarm!.check : null,
            minor: !!parent && !outlines.has(parent.id),
            ...size,
          },
        })
        placed = true
        break
      }
      if (placed) break
    }
  }
  return kept.map((k) => k.label)
}

// ── Area names (room and detail levels) ────────────────────────────────

const AREA_NAME_PX = 12

/** Where an area draws its name (shape-layer.tsx), as a turned box's
 * corners (cells), and whether that box sits inside the area; null for an
 * unnamed one. `grow`: the name grown (Readable). */
export function areaNameBox(
  a: AreaShape,
  grow: number,
  cell: number
): { corners: Pt[]; fits: boolean } | null {
  const name = areaName(a)
  if (!a.show_name || !name) return null
  const fpx = AREA_NAME_PX * grow
  const shift = areaIcon(a) ? fpx + 4 * grow : 0
  const w = (name.length * fpx * NAME_EM + shift) / cell
  const h = (fpx * 1.15) / cell
  if (a.shape === "polygon") {
    if (a.points.length < 3) return null
    const [cx, cy] = polygonCentroid(a.points)
    const corners: Pt[] = [
      [cx - w / 2, cy - h / 2],
      [cx + w / 2, cy - h / 2],
      [cx + w / 2, cy + h / 2],
      [cx - w / 2, cy + h / 2],
    ]
    const xs = a.points.map((p) => p[0])
    const ys = a.points.map((p) => p[1])
    const fits =
      w <= Math.max(...xs) - Math.min(...xs) &&
      h <= Math.max(...ys) - Math.min(...ys)
    return { corners, fits }
  }
  const pad = (6 * grow) / cell
  const top = (4 * grow) / cell
  const corners = boxCorners({
    x: a.x + pad,
    y: a.y + top,
    width: w,
    height: h,
    rotation: 0,
  }).map((p) => turnAbout(p, [a.x + a.width / 2, a.y + a.height / 2], a))
  const fits = w + pad * 2 <= a.width && h + top * 2 <= a.height
  return { corners, fits }
}

function turnAbout(p: Pt, c: Pt, a: AreaShape): Pt {
  const r = ((a.rotation || 0) * Math.PI) / 180
  const dx = p[0] - c[0]
  const dy = p[1] - c[1]
  return [
    c[0] + dx * Math.cos(r) - dy * Math.sin(r),
    c[1] + dx * Math.sin(r) + dy * Math.cos(r),
  ]
}

/** Do two convex quads (corners in order) overlap? Separating axes. */
export function quadsOverlap(a: readonly Pt[], b: readonly Pt[]): boolean {
  for (const poly of [a, b])
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]
      const q = poly[(i + 1) % poly.length]
      const n: Pt = [q[1] - p[1], p[0] - q[0]]
      const proj = (s: readonly Pt[]) => s.map((v) => v[0] * n[0] + v[1] * n[1])
      const pa = proj(a)
      const pb = proj(b)
      if (
        Math.max(...pa) <= Math.min(...pb) ||
        Math.max(...pb) <= Math.min(...pa)
      )
        return false
    }
  return true
}

/** The areas whose name is left out: one that does not sit inside its
 * area, and of two that would overlap the smaller area's (its name shows
 * on hover). */
export function hiddenAreaNames(
  areas: readonly AreaShape[],
  {
    grow = 1,
    cell,
    skip,
  }: {
    grow?: number
    cell: number
    /** Left out whatever: outlines round rooms (roomNesting). */
    skip?: ReadonlySet<string>
  }
): Set<string> {
  const hidden = new Set<string>(skip)
  const sized = areas
    .filter((a) => !hidden.has(a.id))
    .map((a) => ({ a, box: areaNameBox(a, grow, cell), size: areaSize(a) }))
    .filter((x) => x.box)
    .sort((p, q) => q.size - p.size || (p.a.id < q.a.id ? -1 : 1))
  const kept: Pt[][] = []
  for (const { a, box } of sized) {
    if (!box!.fits || kept.some((k) => quadsOverlap(k, box!.corners))) {
      hidden.add(a.id)
      continue
    }
    kept.push(box!.corners)
  }
  return hidden
}

function areaSize(a: AreaShape): number {
  if (a.shape !== "polygon") return a.width * a.height
  let s = 0
  const pts = a.points
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++)
    s += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1])
  return Math.abs(s / 2)
}

// ── The building's footprint ───────────────────────────────────────────

/** Where the building stands (cells), to blank the base map under it: the
 * outer walls' ring (or their hull) - the corridors between the rooms -
 * and every area's outline (a building outlined from the map, a room
 * outside the walls). Empty when the plan has neither. Rings to draw one
 * by one: their windings differ. */
export function buildingFootprint(
  walls: readonly Pick<FloorPlanWall, "points" | "exterior">[],
  areas: readonly AreaShape[],
  grid: { grid_width: number; grid_height: number }
): Pt[][] {
  const out: Pt[][] = []
  if (walls.some((w) => w.exterior && w.points.length >= 2))
    out.push(slabOutline(walls as unknown as SceneWall[], grid))
  for (const a of areas) {
    if (a.shape === "polygon") {
      if (a.points.length >= 3) out.push(a.points.map((p) => [p[0], p[1]]))
      continue
    }
    if (a.width > 0 && a.height > 0) out.push(boxCorners(a))
  }
  return out
}

/** Names as the tile draws them: its short name, else its own. */
export function shownTileName(
  t: FloorPlanTile,
  short: ReadonlyMap<string, string> | null
): string {
  return short?.get(t.id) ?? tileName(t)
}
