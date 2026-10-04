import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type {
  FloorPlanLiveState,
  FloorPlanTile,
  FloorTileRackState,
  Paginated,
  Rack,
} from "@/lib/api"

import { rackFigures } from "./tile-paint"
import type { RackFigures } from "./tile-paint"

/**
 * A floor plan's racks with their port figures (#247):
 * `GET /api/racks/?floor_plan=<id>&include=ports` - the racks its tiles stand
 * for, each once. Asked for when the plan is coloured by a rack measure or
 * its tile popover shows Ports, never on the 30-second live poll: the poll
 * keeps the units and power fresh, these add ports, role and status.
 */
export function planRacksKey(planId: string) {
  return ["floor-plan-racks", planId] as const
}

export function usePlanRacks(planId: string, enabled: boolean) {
  return useQuery({
    queryKey: planRacksKey(planId),
    queryFn: () =>
      api<Paginated<Rack>>(`/api/racks/?floor_plan=${planId}&include=ports`),
    enabled,
  })
}

/** A rack on the plan, as its table lists it: the plan's rack row with its
 * units, power and devices as the live poll last read them, and the tiles
 * that stand for it (one, as a rule). */
export interface PlanRack extends Rack {
  tileIds: string[]
}

function rackLive(
  live: FloorPlanLiveState | null | undefined,
  tileId: string
): FloorTileRackState | null {
  const t = live?.tiles[tileId]
  return t?.kind === "rack" ? t : null
}

/** The plan's racks with a tile among `tiles` (the ones drawn - a rack
 * whose every tile is hidden is left out), freshened from the live poll. */
export function planRackRows(
  racks: readonly Rack[],
  tiles: readonly FloorPlanTile[],
  live: FloorPlanLiveState | null | undefined
): PlanRack[] {
  const byRack = new Map<string, string[]>()
  for (const t of tiles) {
    if (t.linked?.kind !== "rack") continue
    const ids = byRack.get(t.linked.id) ?? []
    ids.push(t.id)
    byRack.set(t.linked.id, ids)
  }
  const rows: PlanRack[] = []
  for (const rack of racks) {
    const tileIds = byRack.get(rack.id)
    if (!tileIds) continue
    const fresh = tileIds
      .map((id) => rackLive(live, id))
      .find((s): s is FloorTileRackState => !!s)
    rows.push(
      fresh
        ? {
            ...rack,
            tileIds,
            used_units: fresh.used_units,
            u_height: fresh.u_height,
            power: fresh.power,
            device_count: fresh.device_count,
            total_weight_kg: fresh.total_weight_kg,
          }
        : { ...rack, tileIds }
    )
  }
  return rows
}

/** Each rack tile's figures, by tile id: the live poll's units and power
 * over the plan's rack row (`racks` may be empty - not asked for, or still
 * loading - and the poll alone then speaks for space and power). */
export function tileRackFigures(
  tiles: readonly FloorPlanTile[],
  racks: readonly Rack[] | undefined,
  live: FloorPlanLiveState | null | undefined
): Map<string, RackFigures> {
  const byId = new Map((racks ?? []).map((r) => [r.id, r] as const))
  const out = new Map<string, RackFigures>()
  for (const t of tiles) {
    if (t.linked?.kind !== "rack") continue
    const fig = rackFigures(byId.get(t.linked.id), rackLive(live, t.id))
    if (fig) out.set(t.id, fig)
  }
  return out
}
