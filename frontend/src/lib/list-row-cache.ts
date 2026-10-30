import type { QueryClient, QueryKey } from "@tanstack/react-query"

/**
 * A detail page's first paint from the list it was opened from: the row with
 * `id` out of any cached list under `listKey` (`["devices"]` holds the device
 * list's pages, each `{ results: [...] }`). Handed to the detail query as
 * `placeholderData`, so a click from the list draws the header and the
 * attributes the row carries at once while the detail read is in flight; the
 * detail-only figures (tab counts, the stack) fill in when it lands.
 *
 * Only rows of the full list serializer belong under `listKey` - a picker's
 * slimmer rows must live under a key of their own.
 */
export function listRowFromCache<T extends { id: string }>(
  qc: QueryClient,
  listKey: QueryKey,
  id: string
): T | undefined {
  for (const [, data] of qc.getQueriesData<{ results?: unknown }>({
    queryKey: listKey,
  })) {
    const rows = data?.results
    if (!Array.isArray(rows)) continue
    const row = rows.find(
      (r): r is T =>
        !!r && typeof r === "object" && (r as { id?: unknown }).id === id
    )
    if (row) return row
  }
  return undefined
}
