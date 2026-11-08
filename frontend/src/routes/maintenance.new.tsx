import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import { MaintenanceEventForm } from "@/components/monitoring/maintenance-event-form"
import { EditPageShell } from "@/components/edit-page-shell"
import {
  AFFECTED_ENDPOINTS,
  affectedQueryOptions,
} from "@/components/feed-affected-panel"
import type { AffectedKind } from "@/components/feed-affected-panel"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"

/** "Plan maintenance" on a power or cooling source's Affected tab (#434) opens
 *  this page with the source, so the event starts with its derived impacts. */
interface NewMaintenanceSearch {
  affected_kind?: AffectedKind
  affected_id?: string
}

export const Route = createFileRoute("/maintenance/new")({
  validateSearch: (s: Record<string, unknown>): NewMaintenanceSearch => {
    const kind = s.affected_kind
    if (
      typeof kind === "string" &&
      kind in AFFECTED_ENDPOINTS &&
      typeof s.affected_id === "string" &&
      s.affected_id
    )
      return {
        affected_kind: kind as AffectedKind,
        affected_id: s.affected_id,
      }
    return {}
  },
  component: NewMaintenanceEventPage,
})

function NewMaintenanceEventPage() {
  const nav = useNavigate()
  const { affected_kind: kind, affected_id: id } = Route.useSearch()
  const from = kind && id ? { kind, id } : null

  const affected = useQuery({
    ...affectedQueryOptions(from?.kind ?? "powerpanel", from?.id ?? ""),
    enabled: !!from,
  })
  const owner = useQuery({
    queryKey: ["affected-owner", from?.kind, from?.id],
    queryFn: () =>
      api<{ name: string }>(`${AFFECTED_ENDPOINTS[from!.kind]}${from!.id}/`),
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
