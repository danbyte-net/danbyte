import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { DeviceCoolingPath } from "@/lib/api"
import { KvCard } from "@/components/kv-card"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import {
  CoolingPathHops,
  CoolingPathStatusBadge,
} from "@/components/cooling-path"

/** The device overview's *Cooling path* card (#434): one row per cooling
 * intake, its path from source through any CDU to this device. */
export function DeviceCoolingPathCard({ deviceId }: { deviceId: string }) {
  const q = useQuery({
    queryKey: ["device-cooling-path", deviceId],
    queryFn: () =>
      api<DeviceCoolingPath>(`/api/devices/${deviceId}/cooling-path/`),
  })
  if (q.isLoading) return <Loading />
  if (q.isError) return <QueryError error={q.error} />
  const paths = q.data?.paths ?? []
  if (paths.length === 0) return null
  return (
    <KvCard
      title="Cooling path"
      rows={paths.map((p) => ({
        label: p.intake.name,
        value: (
          <span className="inline-flex flex-wrap items-center gap-2">
            <CoolingPathHops path={p} />
            {p.status !== "fed" && <CoolingPathStatusBadge status={p.status} />}
          </span>
        ),
      }))}
    />
  )
}
