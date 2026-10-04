import type { QueryClient } from "@tanstack/react-query"

import { invalidateObjectQueries } from "@/lib/save-object"

/**
 * Every cached view drawn from sites: the lists and pickers, and the map
 * payloads (`/api/site-map/…`) read by the Site map page and each embedded
 * MiniMap. The map payloads carry site and region names, colours, icons and
 * coordinates - connection arcs and cable ends too - so a write that leaves
 * any of them cached draws the old values until the staleTime runs out.
 *
 * `["site-map"]` does not prefix-match `["site-map-connections"]`, hence the
 * explicit list. Bulk bars that take a key list spread this in.
 */
export const SITE_VIEW_KEYS: string[][] = [
  ["sites"],
  ["sites-picker"],
  ["site-map"],
  ["site-map-connections"],
  ["site-map-cables"],
]

/**
 * Object types whose writes change the site views. Applying a planned change
 * goes through the generic planning endpoint rather than `/api/sites/…`, so
 * that path checks the change's type against this set.
 */
export const SITE_VIEW_TYPES: ReadonlySet<string> = new Set([
  "api.site",
  "api.region",
])

/**
 * Refetch every site view after a site or region write - create, edit, bulk
 * edit, delete, a move on the map. Pass the written ids to also drop their
 * per-object queries (detail pages, edit-form seeds); leave them out for a
 * delete, where there is nothing left to refetch.
 */
export function invalidateSiteViews(qc: QueryClient, ids: string[] = []) {
  for (const queryKey of SITE_VIEW_KEYS) void qc.invalidateQueries({ queryKey })
  for (const id of ids) invalidateObjectQueries(qc, id)
}
