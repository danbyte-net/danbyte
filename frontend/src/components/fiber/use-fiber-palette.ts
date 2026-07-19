import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { FiberSettings, StrandModelling } from "@/lib/api"
import { TIA_598C } from "@/lib/fiber"
import type { FiberColorEntry } from "@/lib/fiber"

function useFiberSettings() {
  return useQuery({
    queryKey: ["fiber-settings"],
    queryFn: () => api<FiberSettings>("/api/fiber-settings/"),
    staleTime: 10 * 60_000,
  })
}

/** The tenant's fibre palette, falling back to TIA-598-C while loading / on
 * error. Cached app-wide — the palette rarely changes. */
export function useFiberPalette(): FiberColorEntry[] {
  const q = useFiberSettings()
  return q.data?.colors.length ? q.data.colors : TIA_598C
}

/** How deeply this tenant models fibres: `off` | `count` | `accurate`.
 * Drives whether fibre UI (strand map, connector fibre count) appears. */
export function useStrandModelling(): StrandModelling {
  const q = useFiberSettings()
  return q.data?.strand_modelling ?? "count"
}
