/** The Topology page's own address keys: the list's search box. Anything
 * else on `/topology` is a link to the map from before the map moved to
 * `/topology/map` (`?view=…`, `?site=…`, `?device=…`, `?tab=…`), and is
 * sent on there whole. */
export const LIST_KEYS: readonly string[] = ["search"]

/** Whether `/topology` with `search` is an old map link. */
export function isMapSearch(search: Record<string, unknown>): boolean {
  return Object.keys(search).some((k) => !LIST_KEYS.includes(k))
}
