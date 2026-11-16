import type { FloorPlanTile } from "@/lib/api"

import type { Pt } from "./cable-route"
import { tileName } from "./canvas-geometry"
import { CLUSTER_SIDE, squareAt } from "./icon-layout"
import type { IconCluster, IconLayout } from "./icon-layout"
import { findRows, rowAngle, rowName } from "./plan-rows"
import type { RowTile, TileRow } from "./plan-rows"
import type { CellBox } from "./readable"
import { READABLE_SYMBOL_PX, iconTileSubject } from "./readable"
import {
  areaName,
  pointInBox,
  pointInPolygon,
  pointsBounds,
  polygonCentroid,
} from "./shapes"
import type { AreaShape } from "./shapes"

// Levels of detail for rows of racks from afar. Up close the racks are
// drawn and a row is named along it (plan-label-pass.ts). Once its racks
// turn into icons a row is one symbol along its line - a bar the row's
// length, or a single icon with its count when even that is short on
// screen - named "Row F · F01–F12" (or "Row F · 12"), never chopped into
// map-marker clusters. Further out, when a room's rows would run into
// each other, they fold into one summary on the room: "Data Hall 1 · 120
// racks". Each step has its threshold on screen and a wider one back, so
// a zoom about it does not flicker. Clusters (icon-layout.ts) only take
// what is in no row, and never across rooms.
//
// Units: cells, and screen px (or paper mm) at `scale` per cell.

/** A row symbol's bar is at least this thick on screen. */
export const ROW_BAR_MIN_PX = 6
/** A row shorter than this on screen draws as one icon with its count;
 * it is a bar again past ROW_ICON_EXIT_PX. */
export const ROW_ICON_ENTER_PX = 56
export const ROW_ICON_EXIT_PX = 72
/** A room whose rows come closer than this on screen (centre line to
 * centre line) folds them into one summary; it opens again past
 * HALL_EXIT_PX. */
export const HALL_ENTER_PX = 26
export const HALL_EXIT_PX = 34
/** Two room summaries closer than this (px) fold into the room round
 * both; once folded they part only this much further apart. */
export const HALL_PLATE_GAP_PX = 4
export const HALL_PLATE_EXIT_PX = 16
/** A room summary's plate (px): its height and type. */
export const HALL_PLATE_H = 22
export const HALL_FONT_PX = 11

/** A room the plan draws: an area, as the LOD sees it. */
export interface PlanRoom {
  id: string
  name: string
  /** Where its summary sits (cells): a box's middle, a polygon's centroid. */
  at: Pt
  /** Its frame: middle, turn (degrees) and half sizes, before the turn. */
  c: Pt
  rotation: number
  hw: number
  hh: number
  /** Its size (cells²): the smallest room round a point is its room. */
  size: number
  contains: (p: Pt) => boolean
}

/** The plan's rooms, the smallest first. */
export function planRooms(areas: readonly AreaShape[]): PlanRoom[] {
  const out: PlanRoom[] = []
  for (const a of areas) {
    if (a.shape === "polygon") {
      const pts = a.points as Pt[]
      if (pts.length < 3) continue
      const b = pointsBounds(pts)
      let s = 0
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++)
        s += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1])
      out.push({
        id: a.id,
        name: areaName(a),
        at: polygonCentroid(pts),
        c: [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2],
        rotation: 0,
        hw: (b.maxX - b.minX) / 2,
        hh: (b.maxY - b.minY) / 2,
        size: Math.abs(s / 2),
        contains: (p) => pointInPolygon(p, pts),
      })
      continue
    }
    if (!(a.width > 0 && a.height > 0)) continue
    const box = {
      x: a.x,
      y: a.y,
      width: a.width,
      height: a.height,
      rotation: a.rotation,
    }
    const c: Pt = [a.x + a.width / 2, a.y + a.height / 2]
    out.push({
      id: a.id,
      name: areaName(a),
      at: c,
      c,
      rotation: a.rotation,
      hw: a.width / 2,
      hh: a.height / 2,
      size: a.width * a.height,
      contains: (p) => pointInBox(p, box),
    })
  }
  return out.sort((p, q) => p.size - q.size || (p.id < q.id ? -1 : 1))
}

/** The room `p` (cells) is in: the smallest round it, or null. */
export function roomAt(rooms: readonly PlanRoom[], p: Pt): PlanRoom | null {
  for (const r of rooms) if (r.contains(p)) return r
  return null
}

export type Wall = "top" | "right" | "bottom" | "left"

/** The wall of `room` nearest `p` (cells), in the room's own frame. */
export function wallOf(room: PlanRoom, p: Pt): Wall {
  const r = (-room.rotation * Math.PI) / 180
  const dx = p[0] - room.c[0]
  const dy = p[1] - room.c[1]
  const lx = dx * Math.cos(r) - dy * Math.sin(r)
  const ly = dx * Math.sin(r) + dy * Math.cos(r)
  const d: [Wall, number][] = [
    ["left", lx + room.hw],
    ["right", room.hw - lx],
    ["top", ly + room.hh],
    ["bottom", room.hh - ly],
  ]
  return d.reduce((a, b) => (b[1] < a[1] ? b : a))[0]
}

const KIND_PLURAL: Record<string, string> = {
  rack: "racks",
  cabinet: "cabinets",
  device: "devices",
}

/** "12 racks", or "12 objects" for a mix. */
export function countText(kinds: readonly string[]): string {
  const set = new Set(kinds)
  const word = set.size === 1 ? KIND_PLURAL[[...set][0]] : undefined
  return `${kinds.length} ${word ?? "objects"}`
}

/** A row as the LOD keeps it: the row, its room, its names. */
export interface PlanRow extends TileRow {
  kind: string
  room: string | null
  /** "Row F · F01–F12"; "Row F · 12" for a short one. */
  text: string
  short: string
}

/** The rows the plan's icon tiles make (racks, cabinets, devices), with
 * their rooms - from the geometry alone, so once per plan, not per zoom. */
export function planRows(
  tiles: readonly FloorPlanTile[],
  rooms: readonly PlanRoom[],
  angleOf?: (t: FloorPlanTile) => number
): PlanRow[] {
  const subjects: RowTile[] = []
  for (const t of tiles)
    if (iconTileSubject(t))
      subjects.push({
        id: t.id,
        x: t.x,
        y: t.y,
        w: t.width,
        h: t.height,
        angle: angleOf?.(t) ?? 0,
        kind: t.linked?.kind ?? "",
        name: tileName(t),
      })
  const kindOf = new Map(subjects.map((s) => [s.id, s.kind]))
  return findRows(subjects).map((r) => {
    const nm = rowName(r.names)
    const kind = kindOf.get(r.id) ?? ""
    const count = countText(r.members.map(() => kind))
    // "Row F" said with the count; a row without a letter by its count.
    const short = nm.short.startsWith("Row ")
      ? `${nm.short} · ${r.members.length}`
      : count
    return {
      ...r,
      kind,
      room: roomAt(rooms, r.centre)?.id ?? null,
      text: nm.text || count,
      short,
    }
  })
}

/** A row drawn as one symbol: along its line (a bar), or one icon. */
export interface RowSymbol {
  id: string
  row: PlanRow
  bar: boolean
}

/** A room's rows folded into one summary. */
export interface HallSymbol {
  id: string
  room: PlanRoom
  /** "Data Hall 1 · 120 racks". */
  text: string
  members: string[]
  /** Folded from the summaries of rooms inside it. */
  merged: boolean
}

export interface PlanLod {
  scale: number
  rows: RowSymbol[]
  halls: HallSymbol[]
  /** Tile id → the symbol drawing it. */
  ownerOf: ReadonlyMap<string, string>
}

export const EMPTY_LOD: PlanLod = {
  scale: 0,
  rows: [],
  halls: [],
  ownerOf: new Map(),
}

/** A room summary's plate size (px): an icon square, then the text. */
export function hallPlateSize(text: string): { w: number; h: number } {
  return {
    w: HALL_PLATE_H + text.length * HALL_FONT_PX * 0.6 + 10,
    h: HALL_PLATE_H,
  }
}

/** The plate's box (cells) at `perCell` px per cell. */
export function hallBox(at: Pt, text: string, perCell: number): CellBox {
  const s = hallPlateSize(text)
  const w = s.w / perCell
  const h = s.h / perCell
  return { x: at[0] - w / 2, y: at[1] - h / 2, w, h }
}

/** A row bar's thickness (cells) at `perCell`: the row's own depth, or
 * ROW_BAR_MIN_PX on screen when that is thinner. */
export function barThickness(depth: number, perCell: number): number {
  return Math.max(depth, ROW_BAR_MIN_PX / perCell)
}

/** The closest two parallel rows of `rows` side by side (centre line to
 * centre line, cells), or Infinity. */
export function rowPitch(rows: readonly TileRow[]): number {
  let best = Infinity
  for (let i = 0; i < rows.length; i++)
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i]
      const b = rows[j]
      // Parallel: their directions within a couple of degrees.
      if (Math.abs(a.dir[0] * b.dir[1] - a.dir[1] * b.dir[0]) > 0.035) continue
      const d: Pt = [b.centre[0] - a.centre[0], b.centre[1] - a.centre[1]]
      const along = Math.abs(d[0] * a.dir[0] + d[1] * a.dir[1])
      if (along >= (a.length + b.length) / 2) continue
      const across = Math.abs(d[0] * -a.dir[1] + d[1] * a.dir[0])
      best = Math.min(best, across)
    }
  return best
}

/**
 * What draws in place of the rows at `scale` px per cell: each row whose
 * tiles are all icons (`iconIds`) as one row symbol, and a room's rows -
 * with its loose racks - as one summary once they come too close on
 * screen. `prev` (the last LOD) holds each choice until the wider
 * threshold back is crossed. Deterministic.
 */
export function planLod(
  rows: readonly PlanRow[],
  {
    tiles,
    iconIds,
    rooms,
    scale,
    prev = null,
    fold = true,
  }: {
    tiles: readonly FloorPlanTile[]
    iconIds: ReadonlySet<string>
    rooms: readonly PlanRoom[]
    scale: number
    prev?: PlanLod | null
    /** Rooms fold their rows into a summary; off (Detail by zoom: from
     * afar the room's label sums it up) the rows stay bars. */
    fold?: boolean
  }
): PlanLod {
  if (!(scale > 0) || !iconIds.size || !rows.length)
    return { ...EMPTY_LOD, scale }
  const shown = rows.filter((r) => r.members.every((id) => iconIds.has(id)))
  if (!shown.length) return { ...EMPTY_LOD, scale }
  const prevHall = new Map(
    (prev?.halls ?? []).flatMap((h) => h.members.map((id) => [id, h] as const))
  )
  const prevIcon = new Set(
    (prev?.rows ?? []).filter((r) => !r.bar).map((r) => r.id)
  )
  const roomById = new Map(rooms.map((r) => [r.id, r]))
  // Rows by room: those of a room whose rows run together fold.
  const byRoom = new Map<string, PlanRow[]>()
  for (const r of shown)
    if (r.room) byRoom.set(r.room, [...(byRoom.get(r.room) ?? []), r])
  // A row too short on screen for a bar is one icon.
  const isBar = (r: PlanRow, was = prevIcon.has(`row:${r.id}`)) =>
    r.length * scale >= (was ? ROW_ICON_EXIT_PX : ROW_ICON_ENTER_PX)
  // A room folds when its rows run together, or are all down to icons.
  const folded = new Set<string>()
  for (const [room, list] of byRoom) {
    if (!fold || list.length < 2) continue
    const was = list.some((r) => prevHall.has(r.members[0]))
    if (
      rowPitch(list) * scale < (was ? HALL_EXIT_PX : HALL_ENTER_PX) ||
      !list.some((r) => isBar(r, was || prevIcon.has(`row:${r.id}`)))
    )
      folded.add(room)
  }
  const ownerOf = new Map<string, string>()
  const out: RowSymbol[] = []
  for (const r of shown) {
    if (r.room && folded.has(r.room)) continue
    const id = `row:${r.id}`
    out.push({ id, row: r, bar: isBar(r) })
    for (const m of r.members) ownerOf.set(m, id)
  }
  if (!folded.size) return { scale, rows: out, halls: [], ownerOf }
  // A folded room takes its rows and its loose racks and cabinets.
  const kindOf = new Map<string, string>()
  const members = new Map<string, string[]>()
  for (const room of folded)
    members.set(
      room,
      byRoom.get(room)!.flatMap((r) => r.members)
    )
  const inRow = new Set(shown.flatMap((r) => r.members))
  for (const t of tiles) {
    const k = t.linked?.kind ?? ""
    kindOf.set(t.id, k)
    if (!iconIds.has(t.id) || inRow.has(t.id) || ownerOf.has(t.id)) continue
    if (k !== "rack" && k !== "cabinet") continue
    const room = roomAt(rooms, [t.x + t.width / 2, t.y + t.height / 2])
    if (room && folded.has(room.id)) members.get(room.id)!.push(t.id)
  }
  let halls = [...members].map(([room, ids]): HallSymbol => ({
    id: `hall:${room}`,
    room: roomById.get(room)!,
    text: "",
    members: ids,
    merged: false,
  }))
  // Summaries that would touch fold into the room round both, as long as
  // there is one: Data Hall 1 and the cages in it read as Data Hall 1.
  const wasWith = (a: HallSymbol, b: HallSymbol) => {
    const pa = prevHall.get(a.members[0])
    return !!pa && pa === prevHall.get(b.members[0])
  }
  const textOf = (h: HallSymbol) => {
    const count = countText(h.members.map((id) => kindOf.get(id) ?? ""))
    return h.room.name ? `${h.room.name} · ${count}` : count
  }
  for (const h of halls) h.text = textOf(h)
  // At most one fold per room.
  for (let left = rooms.length; left > 0; left--) {
    let merged = false
    outer: for (let i = 0; i < halls.length; i++)
      for (let j = i + 1; j < halls.length; j++) {
        const a = halls[i]
        const b = halls[j]
        const gap = wasWith(a, b) ? HALL_PLATE_EXIT_PX : HALL_PLATE_GAP_PX
        const ba = hallBox(a.room.at, a.text, scale)
        const bb = hallBox(b.room.at, b.text, scale)
        const g = gap / scale
        if (
          ba.x - g >= bb.x + bb.w ||
          bb.x - g >= ba.x + ba.w ||
          ba.y - g >= bb.y + bb.h ||
          bb.y - g >= ba.y + ba.h
        )
          continue
        // The smallest room round both, bigger than either.
        const up = rooms.find(
          (r) =>
            r.size > Math.max(a.room.size, b.room.size) &&
            r.contains(a.room.at) &&
            r.contains(b.room.at)
        )
        if (!up) continue
        const into = halls.find((h) => h.room.id === up.id)
        const next: HallSymbol = {
          id: `hall:${up.id}`,
          room: up,
          text: "",
          members: [...(into?.members ?? []), ...a.members, ...b.members],
          merged: true,
        }
        next.text = textOf(next)
        halls = [...halls.filter((h) => h !== a && h !== b && h !== into), next]
        merged = true
        break outer
      }
    if (!merged) break
  }
  halls.sort((a, b) => (a.id < b.id ? -1 : 1))
  for (const h of halls) for (const id of h.members) ownerOf.set(id, h.id)
  return { scale, rows: out, halls, ownerOf }
}

/** The symbols of `lod` as clusters, laid in with `layout`'s. */
export function withSymbols(layout: IconLayout, lod: PlanLod): IconLayout {
  if (!lod.rows.length && !lod.halls.length) return layout
  const clusters: IconCluster[] = [...layout.clusters]
  const clusterOf = new Map(layout.clusterOf)
  for (const s of lod.rows) {
    const r = s.row
    const c: IconCluster = {
      id: s.id,
      members: r.members,
      anchor: r.centre,
      form: "row",
      row: {
        dir: r.dir,
        length: r.length,
        depth: r.depth,
        bar: s.bar,
      },
      text: r.text,
      short: r.short,
    }
    clusters.push(c)
    for (const id of r.members) clusterOf.set(id, c)
  }
  for (const h of lod.halls) {
    const c: IconCluster = {
      id: h.id,
      members: h.members,
      anchor: h.room.at,
      form: "hall",
      text: h.text,
      short: h.text,
      room: h.room.id,
    }
    clusters.push(c)
    for (const id of h.members) clusterOf.set(id, c)
  }
  return { ...layout, clusters, clusterOf }
}

/** A symbol's drawn box (cells) at `perCell` px per cell: a bar's upright
 * bounds, a row icon's square, a summary's plate; null for a plain
 * cluster. */
export function symbolBox(c: IconCluster, perCell: number): CellBox | null {
  if (c.form === "hall") return hallBox(c.anchor, c.text ?? "", perCell)
  if (c.form !== "row" || !c.row) return null
  if (!c.row.bar)
    return squareAt(c.anchor, READABLE_SYMBOL_PX * CLUSTER_SIDE, perCell)
  const [ux, uy] = c.row.dir
  const hl = c.row.length / 2
  const ht = barThickness(c.row.depth, perCell) / 2
  const ex = Math.abs(ux) * hl + Math.abs(uy) * ht
  const ey = Math.abs(uy) * hl + Math.abs(ux) * ht
  return {
    x: c.anchor[0] - ex,
    y: c.anchor[1] - ey,
    w: ex * 2,
    h: ey * 2,
  }
}

/** A row bar's text angle (upright). */
export function symbolAngle(c: IconCluster): number {
  return c.row ? rowAngle(c.row.dir) : 0
}
