import { useEffect, useMemo, useState } from "react"

import type {
  FloorPlanLiveState,
  FloorPlanTile,
  FloorplanPopoverConfig,
  Rack,
} from "@/lib/api"

import { planRackRows, tileRackFigures, usePlanRacks } from "./plan-racks"
import type { PlanRack } from "./plan-racks"
import { CHECK_COLOR, rackTint } from "./tile-paint"
import type { ColorBy, RackFigures } from "./tile-paint"

/** Does the tile popover show a rack's ports anywhere - in its list or a
 * tile type's own? Then the plan's racks are worth asking for. */
export function popoverShowsPorts(
  cfg: FloorplanPopoverConfig | undefined
): boolean {
  if (!cfg) return false
  return (
    cfg.fields.includes("ports") ||
    Object.values(cfg.tile_overrides).some((f) => f.includes("ports"))
  )
}

/**
 * Everything the floor plan's rack colouring needs, in one place so the
 * page stays wiring (#247): the plan's racks - asked for only while the plan
 * is coloured by a rack measure or the popover shows ports - each rack
 * tile's figures, the rack table's rows, the 3D tints, the legend's input,
 * and the tiles the rack table points at (a hovered row) or keeps (its
 * filter).
 */
export function usePlanCapacity({
  planId,
  tiles,
  live,
  colorBy,
  wantPorts = false,
}: {
  planId: string
  /** The tiles drawn - hidden ones are not coloured, listed or counted. */
  tiles: readonly FloorPlanTile[]
  live: FloorPlanLiveState | null
  colorBy: ColorBy
  /** Something besides the colouring reads the racks' ports. */
  wantPorts?: boolean
}) {
  const coloured = colorBy !== "type"
  const query = usePlanRacks(planId, coloured || wantPorts)
  const racks = query.data?.results

  const figures = useMemo(
    () => tileRackFigures(tiles, racks, live),
    [tiles, racks, live]
  )
  const rows = useMemo<PlanRack[]>(
    () => planRackRows(racks ?? [], tiles, live),
    [racks, tiles, live]
  )
  const rackById = useMemo(
    () => new Map<string, Rack>((racks ?? []).map((r) => [r.id, r])),
    [racks]
  )
  const rackTiles = useMemo(
    () => tiles.filter((t) => t.linked?.kind === "rack"),
    [tiles]
  )

  // The rack table's pointer and filter, by rack id. A plan switch starts
  // clean.
  const [pointRackId, setPointRackId] = useState<string | null>(null)
  const [match, setMatch] = useState<ReadonlySet<string> | null>(null)
  useEffect(() => {
    setPointRackId(null)
    setMatch(null)
  }, [planId])

  const highlightTileIds = useMemo(
    () =>
      new Set(
        pointRackId
          ? rackTiles
              .filter((t) => t.linked?.id === pointRackId)
              .map((t) => t.id)
          : []
      ),
    [rackTiles, pointRackId]
  )
  const dimTileIds = useMemo(
    () =>
      match
        ? new Set(
            rackTiles.filter((t) => !match.has(t.linked!.id)).map((t) => t.id)
          )
        : undefined,
    [rackTiles, match]
  )

  // The 3D room's colour per rack tile - the 2D fill.
  const tints = useMemo(() => {
    const out = new Map<string, string>()
    if (!coloured) return out
    for (const t of rackTiles) {
      const tint = rackTint(colorBy, figures.get(t.id) ?? null)
      if (tint) out.set(t.id, tint)
    }
    return out
  }, [coloured, colorBy, rackTiles, figures])

  // The legend counts racks, not tiles: a rack on two tiles counts once.
  const legend = useMemo(() => {
    const byRack = new Map<string, RackFigures | null>()
    let alarm = false
    for (const t of rackTiles) {
      if (!byRack.has(t.linked!.id))
        byRack.set(t.linked!.id, figures.get(t.id) ?? null)
      const check = live?.tiles[t.id]?.check
      if (check && CHECK_COLOR[check]) alarm = true
    }
    return { figures: [...byRack.values()], alarm }
  }, [rackTiles, figures, live])

  return {
    /** The plan's racks query (idle until wanted). */
    query,
    figures,
    rows,
    rackById,
    /** The plan draws at least one tile linked to a rack. */
    hasRacks: rackTiles.length > 0,
    tints,
    legend,
    pointRackId,
    setPointRackId,
    setMatch,
    highlightTileIds,
    dimTileIds,
  }
}
