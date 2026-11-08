import { keepPreviousData, useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { DashboardData } from "@/lib/api"

/**
 * The dashboard payload (`/api/dashboard/`) for one scope - the query
 * string a named board's scope and frame make, "" for the home dashboard -
 * and one `include` list: the payload keys the widgets on show read, or
 * undefined for all of them.
 *
 * One key per scope and list and one set of options, so every component
 * that reads the payload shares a single request.
 */
export function dashboardQuery(scope = "", include?: string) {
  // Payload keys are plain snake_case: no escaping, so the request reads
  // as written in the network panel.
  const qs = [scope, include !== undefined ? `include=${include}` : ""]
    .filter(Boolean)
    .join("&")
  return {
    queryKey: ["dashboard", scope, include ?? "*"] as const,
    queryFn: () =>
      api<DashboardData>(qs ? `/api/dashboard/?${qs}` : "/api/dashboard/"),
    staleTime: 60_000,
  }
}

export function useDashboardData(
  scope = "",
  opts: {
    include?: string
    enabled?: boolean
    refetchInterval?: number | false
  } = {}
) {
  const { include, ...rest } = opts
  return useQuery({
    ...dashboardQuery(scope, include),
    // A widget added while editing asks for its key: the board keeps the
    // figures it has while that one request is in flight. Another board's
    // (another scope's) figures are never shown in the meantime.
    placeholderData: (prev, prevQuery) =>
      prevQuery?.queryKey[1] === scope ? keepPreviousData(prev) : undefined,
    ...rest,
  })
}
