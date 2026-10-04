import type {
  CabinetSizes,
  FloorPlanLiveState,
  FloorTileCabinetState,
} from "@/lib/api"

// A floor plan tile linked to a DIN-rail cabinet (#277): what the plan reads
// off the cabinet - its box, the cells it covers, its live state.

/** A cabinet's box in mm as the floor plan reads it: its outer size, or what
 * the server draws in its place - the plate plus 50 mm, 200 mm deep. */
export function cabinetOuterMm(c: CabinetSizes): {
  width: number
  height: number
  depth: number
} {
  return {
    width: c.outer_width_mm ?? c.inner_width_mm + 50,
    height: c.outer_height_mm ?? c.inner_height_mm + 50,
    depth: c.outer_depth_mm ?? 200,
  }
}

/** The cells a cabinet stands on: its outer width along the tile's front and
 * its depth front to back, rounded up to whole cells of the plan, at least
 * one each way. A tile facing left or right turns the footprint. */
export function cabinetTileSize(
  c: CabinetSizes,
  cellMm: number,
  orientation: number
): { width: number; height: number } {
  const { width, depth } = cabinetOuterMm(c)
  // A hair under a whole cell stays one cell: 600 mm on a 600 mm grid is 1.
  const cells = (mm: number) =>
    Math.max(1, Math.ceil(mm / Math.max(1, cellMm) - 1e-9))
  const across = cells(width)
  const deep = cells(depth)
  return orientation % 180 === 0
    ? { width: across, height: deep }
    : { width: deep, height: across }
}

/** Where a tile lands resized to `size`: on its own corner, pulled back
 * inside the grid where it would run off, and no larger than the grid. */
export function resizedRect(
  tile: { x: number; y: number },
  size: { width: number; height: number },
  grid: { grid_width: number; grid_height: number }
): { x: number; y: number; width: number; height: number } {
  const width = Math.max(1, Math.min(size.width, grid.grid_width))
  const height = Math.max(1, Math.min(size.height, grid.grid_height))
  return {
    width,
    height,
    x: Math.max(0, Math.min(tile.x, grid.grid_width - width)),
    y: Math.max(0, Math.min(tile.y, grid.grid_height - height)),
  }
}

/** A tile's live state when it is a cabinet's. */
export function cabinetState(
  live: FloorPlanLiveState["tiles"][string] | undefined
): FloorTileCabinetState | null {
  return live?.kind === "cabinet" ? live : null
}
