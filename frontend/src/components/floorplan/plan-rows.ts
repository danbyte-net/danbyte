import { naturalCompare } from "@/lib/natural-sort"

import type { Pt } from "./cable-route"

// Rows of tiles: racks side by side, sharing their turn and a line. A row
// whose names will not sit in its tiles is named once along it - "Row B ·
// B01–B12" - instead of a name or a callout per tile. Found from the
// geometry alone: the plan keeps no row of its own.
//
// Units: cells.

/** A tile as the row finder sees it: its footprint before its turn, and
 * the turn it is drawn with about its centre (degrees). */
export interface RowTile {
  id: string
  x: number
  y: number
  w: number
  h: number
  /** The turn the tile is drawn with about its centre (degrees). */
  angle: number
  /** Tiles of one kind only make a row ("rack", a tile type). */
  kind: string
  name: string
}

export interface TileRow {
  /** Its first member's id: stable as long as the row is. */
  id: string
  /** In order along the row. */
  members: string[]
  names: string[]
  /** The row's centre line: its middle (cells), its direction (unit), its
   * length and its depth across (cells). */
  centre: Pt
  dir: Pt
  length: number
  depth: number
}

/** A row has at least this many tiles. */
export const ROW_MIN = 3
/** Turns within this (degrees) are the same turn. */
const ANGLE_TOL = 2
/** Neighbours in a row: a gap of at most this share of a tile's width
 * between them, and off the line by at most this share of its depth. */
const GAP_SHARE = 0.35
const OFF_SHARE = 0.25
/** Sizes within this share are one size. */
const SIZE_TOL = 0.1

const sameAngle = (a: number, b: number) => {
  // A half turn is the same line: a back-to-back row reads as one axis.
  const d = (((a - b) % 180) + 180) % 180
  return d <= ANGLE_TOL || d >= 180 - ANGLE_TOL
}

const near = (a: number, b: number) =>
  Math.abs(a - b) <= SIZE_TOL * Math.max(a, b)

/**
 * The rows among `tiles`: chains of at least ROW_MIN tiles of one kind
 * and one size, turned alike, each touching the next (or nearly: a seam,
 * not a gap a tile would fit in) along one of their axes and in line with
 * it. A tile in two chains (a block of racks) joins the longer. Rows come
 * in a stable order, their members in order along them.
 */
export function findRows(tiles: readonly RowTile[]): TileRow[] {
  if (tiles.length < ROW_MIN) return []
  // Bucketed by a few cells: neighbours share or touch a bucket.
  const span = Math.max(1, ...tiles.map((t) => Math.max(t.w, t.h)))
  const cell = span * 2
  const grid = new Map<string, number[]>()
  const centre = tiles.map((t): Pt => [t.x + t.w / 2, t.y + t.h / 2])
  tiles.forEach((_, i) => {
    const k = `${Math.floor(centre[i][0] / cell)},${Math.floor(centre[i][1] / cell)}`
    const l = grid.get(k)
    if (l) l.push(i)
    else grid.set(k, [i])
  })
  // Union-find per axis: 0 along the tile's width, 1 along its depth.
  const parents = [tiles.map((_, i) => i), tiles.map((_, i) => i)]
  const find = (p: number[], i: number): number =>
    p[i] === i ? i : (p[i] = find(p, p[i]))
  const join = (p: number[], a: number, b: number) => {
    const ra = find(p, a)
    const rb = find(p, b)
    if (ra !== rb) p[Math.max(ra, rb)] = Math.min(ra, rb)
  }
  tiles.forEach((a, i) => {
    const gx = Math.floor(centre[i][0] / cell)
    const gy = Math.floor(centre[i][1] / cell)
    const r = (a.angle * Math.PI) / 180
    const u: Pt = [Math.cos(r), Math.sin(r)]
    const v: Pt = [-u[1], u[0]]
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const j of grid.get(`${gx + dx},${gy + dy}`) ?? []) {
          if (j <= i) continue
          const b = tiles[j]
          if (b.kind !== a.kind || !sameAngle(a.angle, b.angle)) continue
          if (!near(a.w, b.w) || !near(a.h, b.h)) continue
          const d: Pt = [
            centre[j][0] - centre[i][0],
            centre[j][1] - centre[i][1],
          ]
          const du = Math.abs(d[0] * u[0] + d[1] * u[1])
          const dv = Math.abs(d[0] * v[0] + d[1] * v[1])
          const w = Math.min(a.w, b.w)
          const h = Math.min(a.h, b.h)
          if (dv <= OFF_SHARE * h && du <= w * (1 + GAP_SHARE) && du > w * 0.5)
            join(parents[0], i, j)
          else if (
            du <= OFF_SHARE * w &&
            dv <= h * (1 + GAP_SHARE) &&
            dv > h * 0.5
          )
            join(parents[1], i, j)
        }
  })
  const sizes = parents.map((p) => {
    const n = new Map<number, number>()
    tiles.forEach((_, i) => {
      const r = find(p, i)
      n.set(r, (n.get(r) ?? 0) + 1)
    })
    return n
  })
  // Each tile in its longer chain.
  const rows = new Map<string, number[]>()
  tiles.forEach((_, i) => {
    const r0 = find(parents[0], i)
    const r1 = find(parents[1], i)
    const n0 = sizes[0].get(r0)!
    const n1 = sizes[1].get(r1)!
    const key = n1 > n0 ? `1:${r1}` : `0:${r0}`
    const l = rows.get(key)
    if (l) l.push(i)
    else rows.set(key, [i])
  })
  const out: TileRow[] = []
  for (const [key, idx] of rows) {
    if (idx.length < ROW_MIN) continue
    const first = tiles[idx[0]]
    const r = (first.angle * Math.PI) / 180 + (key[0] === "1" ? Math.PI / 2 : 0)
    let dir: Pt = [Math.cos(r), Math.sin(r)]
    // Read left to right (or top to bottom): the row's direction kept to
    // the right half, so its text is never upside down.
    if (dir[0] < -1e-9 || (Math.abs(dir[0]) <= 1e-9 && dir[1] < 0))
      dir = [-dir[0], -dir[1]]
    const proj = (i: number) => centre[i][0] * dir[0] + centre[i][1] * dir[1]
    const sorted = [...idx].sort(
      (a, b) =>
        proj(a) - proj(b) ||
        (tiles[a].id < tiles[b].id ? -1 : tiles[a].id > tiles[b].id ? 1 : 0)
    )
    const along = key[0] === "1" ? first.h : first.w
    const depth = key[0] === "1" ? first.w : first.h
    const p0 = proj(sorted[0])
    const p1 = proj(sorted.at(-1)!)
    const mid = sorted.reduce<Pt>(
      (s, i) => [s[0] + centre[i][0], s[1] + centre[i][1]],
      [0, 0]
    )
    const c: Pt = [mid[0] / sorted.length, mid[1] / sorted.length]
    // The middle of the row's ends, on its mean line.
    const t = (p0 + p1) / 2 - (c[0] * dir[0] + c[1] * dir[1])
    out.push({
      id: tiles[sorted[0]].id,
      members: sorted.map((i) => tiles[i].id),
      names: sorted.map((i) => tiles[i].name),
      centre: [c[0] + dir[0] * t, c[1] + dir[1] * t],
      dir,
      length: p1 - p0 + along,
      depth,
    })
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** A name's stem and its trailing number ("DH5-B07" → "DH5-B", "07"). */
function split(name: string): { stem: string; num: string } | null {
  const m = /^(.*?)(\d+)$/.exec(name)
  return m ? { stem: m[1], num: m[2] } : null
}

/** What a row's names share before their row letters: "DH5-" for
 * "DH5-A01" … "DH5-A12" (the stem up to its last separator), "" when they
 * share no stem or no separator. A name less this head is still its own
 * ("A01"): what the row's label does not already say. */
export function rowHead(names: readonly string[]): string {
  const named = names.filter(Boolean)
  if (named.length < 2) return ""
  const parts = named.map(split)
  if (!parts.every(Boolean)) return ""
  const stem = parts[0]!.stem
  if (!parts.every((p) => p!.stem === stem)) return ""
  const cut = Math.max(
    stem.lastIndexOf("-"),
    stem.lastIndexOf("_"),
    stem.lastIndexOf(" "),
    stem.lastIndexOf("."),
    stem.lastIndexOf("/")
  )
  return stem.slice(0, cut + 1)
}

/**
 * A row's name: "Row B · B01–B12" when its names share a stem ending in a
 * row letter or two ("DH5-B01" … "DH5-B12"); "R01–R12" for a stem with
 * no letter after its last separator; else the first and the last name
 * ("web-a–web-z"), or the count when the names say nothing. `short` is
 * the shorter form for a short row: the "Row B" alone, else the range.
 */
export function rowName(names: readonly string[]): {
  text: string
  short: string
} {
  const named = names.filter(Boolean)
  if (!named.length) return { text: "", short: "" }
  const sorted = [...named].sort(naturalCompare)
  const first = sorted[0]
  const last = sorted.at(-1)!
  const parts = sorted.map(split)
  if (parts.every(Boolean)) {
    const stem = parts[0]!.stem
    if (parts.every((p) => p!.stem === stem)) {
      // The stem past its last separator: the row's own letters.
      const cut = Math.max(
        stem.lastIndexOf("-"),
        stem.lastIndexOf("_"),
        stem.lastIndexOf(" "),
        stem.lastIndexOf("."),
        stem.lastIndexOf("/")
      )
      const own = stem.slice(cut + 1)
      const head = stem.slice(0, cut + 1)
      const range = `${first.slice(head.length)}–${last.slice(head.length)}`
      // A letter after a separator ("DH5-B"): a row's; "R01" is a name.
      if (cut >= 0 && /^[A-Za-z]{1,3}$/.test(own))
        return { text: `Row ${own} · ${range}`, short: `Row ${own}` }
      return { text: range, short: range }
    }
  }
  if (first === last) return { text: first, short: first }
  const range = `${first}–${last}`
  return { text: range, short: `${named.length} tiles` }
}

/** A text's angle along `dir` (degrees), upright: never upside down. */
export function rowAngle(dir: Pt): number {
  let deg = (Math.atan2(dir[1], dir[0]) * 180) / Math.PI
  if (deg > 90 + 1e-9) deg -= 180
  else if (deg <= -90 + 1e-9) deg += 180
  if (Math.abs(deg - 90) < 1e-9) return 90
  return Math.abs(deg) < 1e-9 ? 0 : deg
}
