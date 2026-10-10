import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type {
  LiveRate,
  LiveRatesPayload,
} from "@/components/site-map/line-utilization"

/** The endpoint's batch limit (`iface_live_api.MAX_IDS`). */
export const LIVE_BATCH = 500
/** Live traffic changes with each poll; a minute keeps the map current
 * without asking more often than samples arrive. */
export const LIVE_REFRESH_MS = 60_000

/** Every interface's live rate in `ids`, batched - only while `enabled`
 * (the Utilization colouring is on). */
export function useLiveRates(ids: readonly string[], enabled: boolean) {
  return useQuery({
    queryKey: ["interfaces-live", ids],
    enabled: enabled && ids.length > 0,
    refetchInterval: LIVE_REFRESH_MS,
    queryFn: async () => {
      const interfaces: Record<string, LiveRate | null> = {}
      let asOf: string | null = null
      for (let i = 0; i < ids.length; i += LIVE_BATCH) {
        const batch = ids.slice(i, i + LIVE_BATCH)
        const r = await api<LiveRatesPayload>(
          `/api/monitoring/interfaces/live/?ids=${batch.join(",")}`
        )
        Object.assign(interfaces, r.interfaces)
        if (r.as_of && (!asOf || r.as_of > asOf)) asOf = r.as_of
      }
      return { as_of: asOf, interfaces } satisfies LiveRatesPayload
    },
  })
}
