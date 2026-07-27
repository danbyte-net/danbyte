import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useUrlTab } from "@/lib/use-url-tab"
import { useQuery } from "@tanstack/react-query"
import { Pencil, Trash2 } from "lucide-react"
import { useCallback, useState } from "react"

import { api, type ProviderNetwork } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { TimeCell } from "@/components/cells/time-ago"
import { TagList } from "@/components/cells/tag-list"
import { KvCard, dash } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { QueryError } from "@/components/query-error"
import { ProviderNetworkDeleteDialog } from "@/components/provider-network-delete-dialog"
import {
  DetailHero,
  DetailShell,
  DetailStat,
  DetailTab,
} from "@/components/detail-shell"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { CustomFieldValues } from "@/components/custom-field-display"
import { EmbeddedCircuitTable } from "@/components/embedded-tables"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/provider-networks/$id")({
  component: ProviderNetworkDetail,
})

function ProviderNetworkDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["provider-network", id],
    queryFn: () => api<ProviderNetwork>(`/api/provider-networks/${id}/`),
  })
  if (q.isLoading)
    return <p className="p-6 text-sm text-muted-foreground">Loading…</p>
  if (q.isError)
    return (
      <div className="p-6">
        <QueryError error={q.error} />
      </div>
    )
  if (!q.data) return null
  return <Body network={q.data} />
}

function Body({ network: n }: { network: ProviderNetwork }) {
  const [tab, setTab] = useUrlTab<
    "overview" | "circuits" | "journal" | "history"
  >("overview")
  const nav = useNavigate()
  const { canDo } = useMe()
  const [deleting, setDeleting] = useState<ProviderNetwork | null>(null)
  const goBack = useCallback(() => nav({ to: "/provider-networks" }), [nav])

  return (
    <DetailShell
      backTo="/provider-networks"
      backLabel="Provider networks"
      title={n.name}
      presence={{ type: "providernetwork", id: n.id }}
      actions={
        <>
          {canDo("providernetwork", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/provider-networks/$id/edit" params={{ id: n.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("providernetwork", "delete") && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleting(n)}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          )}
        </>
      }
      hero={
        <>
          <DetailHero
            title={n.name}
            subtitle={
              <Link
                to="/providers/$id"
                params={{ id: n.provider.id }}
                className="text-primary hover:underline"
              >
                {n.provider.name}
              </Link>
            }
            tags={n.tags.length > 0 && <TagList tags={n.tags} />}
            statCols={1}
            stats={
              <DetailStat
                label="Circuits"
                value={<span className="num">{n.circuit_count}</span>}
              />
            }
          />
          <CustomFieldValues model="providernetwork" values={n.custom_fields} />
        </>
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "circuits", label: "Circuits", count: n.circuit_count },
        { value: "journal", label: "Journal" },
        { value: "history", label: "History" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as typeof tab)}
    >
      <DetailTab value="overview">
        <NetworkOverview network={n} />
      </DetailTab>
      <DetailTab value="circuits">
        <EmbeddedCircuitTable
          filter={{ provider_network: n.id }}
          emptyText="No circuits terminate on this network yet."
        />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.providernetwork" objectId={n.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.providernetwork" objectId={n.id} />
      </DetailTab>

      <ProviderNetworkDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

function NetworkOverview({ network: n }: { network: ProviderNetwork }) {
  const { humanIds } = useMe()

  const details: KvRow[] = [
    ...(humanIds && n.numid != null
      ? [
          {
            label: "Number",
            value: <span className="num font-mono">#{n.numid}</span>,
          } satisfies KvRow,
        ]
      : []),
    {
      label: "Provider",
      value: (
        <Link
          to="/providers/$id"
          params={{ id: n.provider.id }}
          className="text-primary hover:underline"
        >
          {n.provider.name}
        </Link>
      ),
    },
    {
      label: "Service ID",
      value: n.service_id ? (
        <span className="font-mono text-[13px]">{n.service_id}</span>
      ) : (
        dash
      ),
      copy: n.service_id || undefined,
    },
  ]

  const record: KvRow[] = [
    { label: "Created", value: <TimeCell iso={n.created_at} /> },
    { label: "Updated", value: <TimeCell iso={n.updated_at} /> },
  ]

  const notes: KvRow[] = [
    { label: "Description", value: n.description || dash },
    {
      label: "Comments",
      value: n.comments ? (
        <span className="whitespace-pre-wrap">{n.comments}</span>
      ) : (
        dash
      ),
    },
  ]

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <KvCard title="Provider network" rows={details} />
      <KvCard title="Record" rows={record} />
      <KvCard title="Notes" rows={notes} />
    </div>
  )
}
