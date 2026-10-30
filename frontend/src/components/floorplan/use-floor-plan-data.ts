import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import type {
  DeviceRole,
  FloorPlan,
  FloorPlanCablePath,
  FloorPlanLiveState,
  FloorplanPopoverConfig,
  FloorPlanTile,
  FloorPlanTray,
  FloorPlanWall,
  FloorTileTypeOption,
  Paginated,
  RaisedFloorArea,
} from "@/lib/api"

/** Everything the floor-plan editor reads from the server: the plan, what is
 * drawn on it, the palette catalogs, the live overlay and the sibling floors. */
export function useFloorPlanData(id: string) {
  const planQuery = useQuery({
    queryKey: ["floor-plan", id],
    queryFn: () => api<FloorPlan>(`/api/floor-plans/${id}/`),
  })
  const tilesQuery = useQuery({
    queryKey: ["floor-plan-tiles", id],
    queryFn: () =>
      api<Paginated<FloorPlanTile>>(
        `/api/floor-plan-tiles/?floor_plan=${id}&page_size=1000`
      ),
  })
  const tileTypes = useQuery({
    queryKey: ["floor-tile-types-picker"],
    queryFn: () =>
      apiAll<FloorTileTypeOption>("/api/floor-tile-types/?picker=1"),
  })
  const roles = useQuery({
    queryKey: ["device-roles"],
    queryFn: () => apiAll<DeviceRole>("/api/device-roles/"),
  })
  // Live per-tile metrics (rack utilization, monitoring rollup) - cheap to
  // poll; monitoring pushes state server-side so 30s keeps tiles honest.
  const liveState = useQuery({
    queryKey: ["floor-plan-state", id],
    queryFn: () => api<FloorPlanLiveState>(`/api/floor-plans/${id}/state/`),
    refetchInterval: 30_000,
  })
  // Which rows the tile popover shows (Settings → Deployment → Floor plans,
  // resolved per tenant). Any member may read it; falls back to the built-in
  // set while it loads or if it's unset.
  const popoverCfg = useQuery({
    queryKey: ["floorplan-popover"],
    queryFn: () => api<FloorplanPopoverConfig>("/api/floorplan-popover/"),
    staleTime: 5 * 60_000,
  })

  // Sibling plans of the same location - the "floors" of this building
  // (Floor 1 / Floor 2 / Basement…). Powers the header switcher.
  const locationId = planQuery.data?.location.id
  const floors = useQuery({
    queryKey: ["floor-plans", "location", locationId],
    queryFn: () =>
      api<Paginated<FloorPlan>>(
        `/api/floor-plans/?location=${locationId}&page_size=100`
      ),
    enabled: !!locationId,
  })

  const traysQuery = useQuery({
    queryKey: ["floor-plan-trays", id],
    queryFn: () =>
      api<Paginated<FloorPlanTray>>(
        `/api/floor-plan-trays/?floor_plan=${id}&page_size=500`
      ),
  })
  const trays = traysQuery.data?.results ?? []
  // Raised-floor areas (Structure mode) - rectangles with a plenum depth.
  const areasQuery = useQuery({
    queryKey: ["floor-plan-raised-floors", id],
    queryFn: () =>
      api<Paginated<RaisedFloorArea>>(
        `/api/floor-plan-raised-floors/?floor_plan=${id}&page_size=500`
      ),
  })
  const areas = areasQuery.data?.results ?? []
  // Walls (Structure mode) - polylines with door openings.
  const wallsQuery = useQuery({
    queryKey: ["floor-plan-walls", id],
    queryFn: () =>
      api<Paginated<FloorPlanWall>>(
        `/api/floor-plan-walls/?floor_plan=${id}&page_size=500`
      ),
  })
  const walls = wallsQuery.data?.results ?? []
  const cablePathsQuery = useQuery({
    queryKey: ["floor-plan-cable-paths", id],
    queryFn: () =>
      api<{ cables: FloorPlanCablePath[] }>(
        `/api/floor-plans/${id}/cable-paths/`
      ),
  })
  const cablePaths = cablePathsQuery.data?.cables ?? []

  return {
    planQuery,
    plan: planQuery.data,
    tilesQuery,
    /** The saved tiles - undefined until they land. */
    serverTiles: tilesQuery.data?.results,
    tileTypes,
    roles,
    liveState,
    popoverCfg,
    floors,
    trays,
    areas,
    walls,
    cablePaths,
  }
}

export type FloorPlanData = ReturnType<typeof useFloorPlanData>
