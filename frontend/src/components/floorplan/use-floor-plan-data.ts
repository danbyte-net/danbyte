import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import type {
  DeviceRole,
  FloorPlan,
  FloorPlanCablePath,
  FloorPlanContents,
  FloorPlanLiveState,
  FloorplanPopoverConfig,
  FloorTileTypeOption,
  Paginated,
} from "@/lib/api"

/** The query key of a plan's contents (tiles, trays, walls, raised floors) -
 * what an edit of any of them invalidates. */
export const floorPlanContentsKey = (id: string) =>
  ["floor-plan-contents", id] as const

/** Everything the floor-plan editor reads from the server: the plan, what is
 * drawn on it, the palette catalogs, the live overlay and the sibling floors. */
export function useFloorPlanData(id: string) {
  const planQuery = useQuery({
    queryKey: ["floor-plan", id],
    queryFn: () => api<FloorPlan>(`/api/floor-plans/${id}/`),
  })
  // Tiles, trays, walls and raised floors in one read, every row of them -
  // a list page would stop at its page size and quietly drop the rest.
  const contentsQuery = useQuery({
    queryKey: floorPlanContentsKey(id),
    queryFn: () => api<FloorPlanContents>(`/api/floor-plans/${id}/contents/`),
  })
  const contents = contentsQuery.data
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
    contentsQuery,
    /** The saved tiles - undefined until they land. */
    serverTiles: contents?.tiles,
    trays: contents?.trays ?? [],
    // Raised-floor areas (Structure mode) - rectangles with a plenum depth.
    areas: contents?.raised_floors ?? [],
    // Walls (Structure mode) - polylines with door openings.
    walls: contents?.walls ?? [],
    tileTypes,
    roles,
    liveState,
    popoverCfg,
    floors,
    cablePaths,
  }
}

export type FloorPlanData = ReturnType<typeof useFloorPlanData>
