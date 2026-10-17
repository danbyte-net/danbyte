// Working a selection of tiles at once in the floor plan editor: moving it
// as one, turning it a quarter, and finding tiles by what they are. Pure, so
// the page and the tests share them. Every move keeps the editor's rules:
// inside the grid, and never onto a tile outside the selection (zones may be
// covered and may cover anything).

export interface GridTile {
  id: string
  x: number
  y: number
  width: number
  height: number
  orientation: 0 | 90 | 180 | 270
  tile_type?: { is_zone?: boolean } | null
}

export interface Grid {
  grid_width: number
  grid_height: number
}

export type TilePatch = Pick<GridTile, "x" | "y" | "width" | "height"> & {
  orientation?: GridTile["orientation"]
}

const isZone = (t: GridTile) => !!t.tile_type?.is_zone

const overlaps = (
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number }
) =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height

/** The patches when none of them leaves the grid or lands on a tile
 * outside the selection; null when one would. */
function settle<T extends GridTile>(
  tiles: readonly T[],
  ids: ReadonlySet<string>,
  patches: Map<string, TilePatch>,
  grid: Grid
): Map<string, TilePatch> | null {
  for (const p of patches.values())
    if (
      p.x < 0 ||
      p.y < 0 ||
      p.x + p.width > grid.grid_width ||
      p.y + p.height > grid.grid_height
    )
      return null
  const rest = tiles.filter((t) => !ids.has(t.id) && !isZone(t))
  for (const t of tiles) {
    const p = patches.get(t.id)
    if (!p || isZone(t)) continue
    if (rest.some((o) => overlaps(p, o))) return null
  }
  return patches
}

/** The selection moved by `dx`, `dy` cells, or null when it can't go. */
export function moveSelection<T extends GridTile>(
  tiles: readonly T[],
  ids: ReadonlySet<string>,
  dx: number,
  dy: number,
  grid: Grid
): Map<string, TilePatch> | null {
  const patches = new Map<string, TilePatch>()
  for (const t of tiles)
    if (ids.has(t.id))
      patches.set(t.id, {
        x: t.x + dx,
        y: t.y + dy,
        width: t.width,
        height: t.height,
      })
  if (!patches.size) return null
  return settle(tiles, ids, patches, grid)
}

/** The furthest the selection can go towards `dx`, `dy` (each clamped to
 * the grid's edges), so a drag past the edge stops at it. */
export function clampSelectionDelta<T extends GridTile>(
  tiles: readonly T[],
  ids: ReadonlySet<string>,
  dx: number,
  dy: number,
  grid: Grid
): { dx: number; dy: number } {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const t of tiles)
    if (ids.has(t.id)) {
      minX = Math.min(minX, t.x)
      minY = Math.min(minY, t.y)
      maxX = Math.max(maxX, t.x + t.width)
      maxY = Math.max(maxY, t.y + t.height)
    }
  if (minX === Infinity) return { dx: 0, dy: 0 }
  return {
    dx: Math.max(-minX, Math.min(grid.grid_width - maxX, dx)),
    dy: Math.max(-minY, Math.min(grid.grid_height - maxY, dy)),
  }
}

/**
 * The selection turned a quarter clockwise as one piece, about the centre
 * of its bounding box: each tile's footprint and place turn with it and its
 * facing turns by 90°. Null when the turned piece would leave the grid or
 * land on a tile outside the selection.
 */
export function rotateSelection<T extends GridTile>(
  tiles: readonly T[],
  ids: ReadonlySet<string>,
  grid: Grid
): Map<string, TilePatch> | null {
  const sel = tiles.filter((t) => ids.has(t.id))
  if (!sel.length) return null
  const bx = Math.min(...sel.map((t) => t.x))
  const by = Math.min(...sel.map((t) => t.y))
  const bw = Math.max(...sel.map((t) => t.x + t.width)) - bx
  const bh = Math.max(...sel.map((t) => t.y + t.height)) - by
  // The turned box keeps the old box's centre, on whole cells.
  const nx = Math.round(bx + bw / 2 - bh / 2)
  const ny = Math.round(by + bh / 2 - bw / 2)
  const patches = new Map<string, TilePatch>()
  for (const t of sel) {
    const u = t.x - bx
    const v = t.y - by
    patches.set(t.id, {
      x: nx + (bh - (v + t.height)),
      y: ny + u,
      width: t.height,
      height: t.width,
      orientation: ((t.orientation + 90) % 360) as GridTile["orientation"],
    })
  }
  return settle(tiles, ids, patches, grid)
}

/** What a tile is found by: its label, the rack, device, cabinet or panel
 * it stands for, and its type or role. */
export interface SearchableTile {
  id: string
  label: string
  linked?: { kind: string; name: string } | null
  tile_type?: { name: string } | null
  role_type?: { name: string } | null
}

export interface TileHit<T> {
  tile: T
  /** Found by its type or role rather than a name of its own. */
  byType: boolean
}

/**
 * Tiles matching `query` - every word, any case, in any order - best
 * first: by the tile's label, then by the object it links (a rack, a
 * device…), then by its type or role.
 */
export function searchTiles<T extends SearchableTile>(
  tiles: readonly T[],
  query: string,
  limit = 8
): TileHit<T>[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return []
  const all = (s: string | null | undefined) =>
    !!s && words.every((w) => s.toLowerCase().includes(w))
  const ranked: { hit: TileHit<T>; rank: number }[] = []
  for (const t of tiles) {
    const rank = all(t.label)
      ? 0
      : all(t.linked?.name)
        ? 1
        : all(t.tile_type?.name ?? t.role_type?.name)
          ? 2
          : -1
    if (rank >= 0) ranked.push({ hit: { tile: t, byType: rank === 2 }, rank })
  }
  // A stable sort: the plan's own order within a rank.
  return ranked
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit)
    .map((r) => r.hit)
}
