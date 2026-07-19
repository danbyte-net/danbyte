import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { Paginated, SiteOption } from "@/lib/api"
import { useMe } from "@/lib/use-me"

/**
 * The site options a form should offer as a WRITE destination.
 *
 * Replaces the per-form `["sites-picker"]` query. Normally returns every site
 * in the tenant; under **enhanced site separation** a site-scoped user only
 * gets the sites they may edit (`me.editable_sites`), and when that leaves
 * exactly one, `lockedId` names it so the form can prefill and disable the
 * site field. The server enforces independently (serializer field filter +
 * post-save guard) — this is UX, not the boundary.
 *
 * Read-side filters (list-page facets, search pickers) should NOT use this:
 * separation never narrows what a user can see, only where they can write.
 */
export function useSiteOptions() {
  const { me } = useMe()
  const q = useQuery({
    queryKey: ["sites-picker"],
    queryFn: () => api<Paginated<SiteOption>>("/api/sites/"),
    staleTime: 10 * 60_000,
  })
  const all = q.data?.results ?? []
  const fenced = me.site_separation === true && Array.isArray(me.editable_sites)
  const options = fenced
    ? all.filter((s) => (me.editable_sites as string[]).includes(s.id))
    : all
  return {
    options,
    isLoading: q.isLoading,
    /** Set when separation leaves exactly one choosable site. */
    lockedId: fenced && options.length === 1 ? options[0].id : null,
  }
}
