import { Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { Server } from "lucide-react"

import { api } from "@/lib/api"
import type { DependencyImpact } from "@/lib/api"
import {
  AffectedHeader,
  AffectedRow,
  AffectedSection,
  affectedLinkCls,
} from "@/components/affected-panel"
import { EmptyState } from "@/components/empty-state"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"

export function deviceImpactQueryOptions(id: string) {
  return {
    queryKey: ["device-impact", id],
    queryFn: () => api<DependencyImpact>(`/api/devices/${id}/impact/`),
  }
}

/** "What if this fails?" (#450): the devices that go down with this one,
 * or lose redundancy, through their dependencies. **Plan maintenance**
 * opens a new event with exactly these impacts. */
export function DeviceImpactPanel({ id, name }: { id: string; name: string }) {
  const nav = useNavigate()
  const q = useQuery(deviceImpactQueryOptions(id))
  if (q.isLoading) return <Loading />
  if (q.error) return <QueryError error={q.error} />
  const data = q.data
  if (!data) return null
  const outage = data.devices.filter((d) => d.level === "outage")
  const reduced = data.devices.filter((d) => d.level !== "outage")

  const row = (d: DependencyImpact["devices"][number]) => (
    <AffectedRow
      key={d.id}
      icon={Server}
      name={d.name}
      level={d.level}
      note={
        [
          d.via.length ? `via ${d.via.map((v) => v.name).join(", ")}` : "",
          d.site?.name ?? "",
        ]
          .filter(Boolean)
          .join(" · ") || undefined
      }
      link={
        <Link
          to="/devices/$id"
          params={{ id: d.id }}
          className={affectedLinkCls}
        >
          {d.name}
        </Link>
      }
    />
  )

  return (
    <div className="space-y-4">
      <AffectedHeader
        text={`If ${name} fails`}
        onPlan={() =>
          nav({
            to: "/maintenance/new",
            search: { affected_kind: "device", affected_id: id },
          })
        }
      />
      {data.devices.length === 0 ? (
        <EmptyState title="Nothing depends on it." />
      ) : (
        <>
          <AffectedSection title="Down" count={outage.length}>
            {outage.map(row)}
          </AffectedSection>
          <AffectedSection title="Reduced redundancy" count={reduced.length}>
            {reduced.map(row)}
          </AffectedSection>
          {data.truncated && (
            <p className="text-[11px] text-muted-foreground">
              Showing the first {data.devices.length}.
            </p>
          )}
        </>
      )}
    </div>
  )
}
