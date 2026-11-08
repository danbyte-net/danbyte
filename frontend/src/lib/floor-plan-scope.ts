import type { LocationOption, SiteOption } from "@/lib/api"

// What a floor spans: its location and the locations inside it, or - on a
// site-wide floor plan, which has no location - its whole site. Room and
// location pickers, the Place picker's labels and the editor's subtitle all
// read it from here.

interface Scoped {
  site: SiteOption
  location: LocationOption | null
}

/** The label of a floor plan with no location. */
export const WHOLE_SITE = "Whole site"

/** Whether the floor (or floor plan) spans its whole site. */
export function isSiteWide(plan: Scoped): boolean {
  return plan.location == null
}

/** A cache-key part naming the scope. */
export function scopeKey(plan: Scoped): string {
  return plan.location?.id ?? `site:${plan.site.id}`
}

/** The scope's name: the location's, else the site's. */
export function scopeName(plan: Scoped): string {
  return plan.location?.name ?? plan.site.name
}

/** The rooms an area on the floor may stand for. */
export function scopeRoomsUrl(plan: Scoped): string {
  return plan.location
    ? `/api/rooms/?picker=1&location=${plan.location.id}&include_descendants=1`
    : `/api/rooms/?picker=1&site=${plan.site.id}`
}

/** The ids of the locations the floor spans, from every location of its
 * site: the floor's location and those nested under it, or all of them. */
export function scopeLocationIds(
  plan: Scoped,
  all: { id: string; parent?: { id: string } | null }[]
): Set<string> {
  if (!plan.location) return new Set(all.map((l) => l.id))
  const inside = new Set([plan.location.id])
  // Parents before children is not guaranteed: walk until nothing joins.
  for (let grew = true; grew;) {
    grew = false
    for (const l of all)
      if (l.parent && inside.has(l.parent.id) && !inside.has(l.id)) {
        inside.add(l.id)
        grew = true
      }
  }
  return inside
}
