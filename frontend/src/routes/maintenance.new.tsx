import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { DependencyImpact } from "@/lib/api"
import { MaintenanceEventForm } from "@/components/monitoring/maintenance-event-form"
import { EditPageShell } from "@/components/edit-page-shell"
import {
  AFFECTED_ENDPOINTS,
  affectedQueryOptions,
} from "@/components/feed-affected-panel"
import type {
  AffectedImpact,
  AffectedKind,
} from "@/components/feed-affected-panel"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"

/** "Plan maintenance" on a power or cooling source's Affected tab (#434), or
 *  on a device's "What if this fails?" (#450), opens this page with the
 *  source or device, so the event starts with its derived impacts. */
type PrefillKind = AffectedKind | "device"

interface NewMaintenanceSearch {
  affected_kind?: PrefillKind
  affected_id?: string
}

const PREFILL_ENDPOINTS: Record<PrefillKind, string> = {
  ...AFFECTED_ENDPOINTS,
  device: "/api/devices/",
}

export const Route = createFileRoute("/maintenance/new")({
  validateSearch: (s: Record<string, unknown>): NewMaintenanceSearch => {
    const kind = s.affected_kind
    if (
      typeof kind === "string" &&
      kind in PREFILL_ENDPOINTS &&
      typeof s.affected_id === "string" &&
      s.affected_id
    )
      return {
        affected_kind: kind as PrefillKind,
        affected_id: s.affected_id,
      }
    return {}
  },
  component: NewMaintenanceEventPage,
})

/** The impacts to prefill: a feed source's affected answer, or a device's
 *  dependency impact (itself and what goes down with it). */
function prefillQueryOptions(
  kind: PrefillKind,
  id: string
): {
  queryKey: readonly unknown[]
  queryFn: () => Promise<{ impacts: AffectedImpact[] }>
} {
  if (kind === "device")
    return {
      queryKey: ["device-impact", id],
      queryFn: () => api<DependencyImpact>(`/api/devices/${id}/impact/`),
    }
  return affectedQueryOptions(kind, id)
}

function NewMaintenanceEventPage() {
  const nav = useNavigate()
  const { affected_kind: kind, affected_id: id } = Route.useSearch()
  const from = kind && id ? { kind, id } : null

  const affected = useQuery({
    ...prefillQueryOptions(from?.kind ?? "powerpanel", from?.id ?? ""),
    enabled: !!from,
  })
  const owner = useQuery({
    queryKey: ["affected-owner", from?.kind, from?.id],
    queryFn: () =>
      api<{ name: string }>(`${PREFILL_ENDPOINTS[from!.kind]}${from!.id}/`),
    enabled: !!from,
  })

  const back = () => nav({ to: "/maintenance" })
  const error = affected.error ?? owner.error
  return (
    <EditPageShell
      wide
      crumbs={[{ label: "Maintenance", to: "/maintenance" }, { label: "New" }]}
      title="New maintenance or outage event"
    >
      {from && error ? (
        <QueryError error={error} />
      ) : from && (affected.isLoading || owner.isLoading) ? (
        <Loading />
      ) : (
        <MaintenanceEventForm
          onSaved={back}
          onCancel={back}
          initialImpacts={from ? affected.data?.impacts : undefined}
          initialName={
            from && owner.data ? `Maintenance on ${owner.data.name}` : undefined
          }
        />
      )}
    </EditPageShell>
  )
}
