import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { SiteMapCable, SiteMapConnection } from "@/lib/api"

// The site map page's lines, with their speeds and the links behind them
// (`?include=capacity`, #246). The dashboard widget and the site and device
// locators read the same endpoints without it, under the bare keys - so the
// page keeps its payload under keys of its own and the mini maps never pay
// for, or receive, the heavier one. Both keys extend the bare ones, so every
// invalidation of `["site-map-connections"]` / `["site-map-cables"]` (a site
// move, a new cable, `invalidateSiteViews`) refreshes the page too.

export const MAP_CONNECTIONS_KEY = ["site-map-connections", "capacity"] as const
export const MAP_CABLES_KEY = ["site-map-cables", "capacity"] as const

export const MAP_CONNECTIONS_URL = "/api/site-map/connections/?include=capacity"
export const MAP_CABLES_URL = "/api/site-map/cables/?include=capacity"

export function useMapConnections() {
  return useQuery({
    queryKey: MAP_CONNECTIONS_KEY,
    queryFn: () =>
      api<{ connections: SiteMapConnection[] }>(MAP_CONNECTIONS_URL),
  })
}

export function useMapCables() {
  return useQuery({
    queryKey: MAP_CABLES_KEY,
    queryFn: () => api<{ cables: SiteMapCable[] }>(MAP_CABLES_URL),
  })
}
