import { useMemo } from "react"
import { useRouterState } from "@tanstack/react-router"

import type { FacetVisibility } from "@/components/filter-rail"
import { useTablePreference } from "@/lib/use-table-preference"

/** The pref id a list's hidden facets are stored under: `facets-` + the
 * route, so it is per list (not per object) and stays a slug the
 * /api/prefs/columns/<id>/ endpoint accepts. */
export function facetPrefId(routeId: string): string | undefined {
  const slug = routeId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug ? `facets-${slug}`.slice(0, 64) : undefined
}

/**
 * Which facets the user hid on the current list (#285). Stored server-side
 * like a column layout - the same per-user, per-tenant pref row, under its
 * own id, so it never mixes with (or is locked by) the table's columns.
 */
export function useListFacetPrefs(): FacetVisibility | null {
  const routeId = useRouterState({
    select: (s) => s.matches[s.matches.length - 1]?.routeId ?? "",
  })
  const prefId = facetPrefId(routeId)
  const pref = useTablePreference(prefId)
  const { hidden, setLayout, loaded } = pref
  return useMemo(
    () =>
      prefId && loaded
        ? { hidden, setHidden: (next) => setLayout({ hidden: next }) }
        : null,
    [prefId, loaded, hidden, setLayout]
  )
}
