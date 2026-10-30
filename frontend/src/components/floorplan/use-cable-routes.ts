import { useMemo, useRef } from "react"

import type {
  FloorPlanCablePath,
  FloorPlanTile,
  FloorPlanTray,
} from "@/lib/api"

import { CableRouteCache } from "./cable-draw"
import type { CableRoute } from "./cable-draw"
import type { PlenumRect } from "./cable-route"

/** Every cable's route on the plan, routed again only when the plan's
 * contents change - and then only the cables whose ends or trays moved
 * (cable-draw.ts `CableRouteCache`). A pan or a zoom routes nothing. */
export function useCableRoutes(
  cablePaths: readonly FloorPlanCablePath[],
  trays: FloorPlanTray[],
  tiles: FloorPlanTile[],
  ceilingMm: number | undefined,
  areas: PlenumRect[] | undefined
): Map<string, CableRoute> {
  const cache = useRef<CableRouteCache | null>(null)
  if (!cache.current) cache.current = new CableRouteCache()
  return useMemo(
    () => cache.current!.routes(cablePaths, { trays, tiles, ceilingMm, areas }),
    [cablePaths, trays, tiles, ceilingMm, areas]
  )
}
