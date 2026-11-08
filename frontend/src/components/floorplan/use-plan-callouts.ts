import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"

import type { CalloutLine } from "./plan-callouts"

const NONE: ReadonlyMap<string, readonly CalloutLine[]> = new Map()

/**
 * The lines under each tile's callout name - the callout fields of the
 * panel layout its object takes (Settings → Floor plans → Detail panels),
 * from GET /api/floor-plans/<id>/callouts/ - asked for only while
 * callouts are on. A plan with none chosen reads an empty map: the
 * callouts show the name alone.
 */
export function usePlanCallouts(
  planId: string,
  enabled: boolean
): ReadonlyMap<string, readonly CalloutLine[]> {
  const q = useQuery({
    queryKey: ["floor-plan-callouts", planId],
    queryFn: () =>
      api<{ tiles: Record<string, CalloutLine[]> }>(
        `/api/floor-plans/${planId}/callouts/`
      ),
    enabled,
    staleTime: 30_000,
  })
  return useMemo(
    () => (q.data ? new Map(Object.entries(q.data.tiles)) : NONE),
    [q.data]
  )
}
