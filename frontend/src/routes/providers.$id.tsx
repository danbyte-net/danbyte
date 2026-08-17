import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useUrlTab } from "@/lib/use-url-tab"
import { useQuery } from "@tanstack/react-query"
import { ExternalLink, Pencil, Trash2 } from "lucide-react"
import { useCallback, useState } from "react"

import {
  api,
  type Paginated,
  type Provider,
  type ProviderNetwork,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import { SimpleTable } from "@/components/ui/simple-table"
import { TimeCell } from "@/components/cells/time-ago"
import { TagList } from "@/components/cells/tag-list"
import { KvCard, dash } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { QueryError } from "@/components/query-error"
import { ProviderDeleteDialog } from "@/components/provider-delete-dialog"
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

export const Route = createFileRoute("/providers/$id")({
  component: ProviderDetail,
})

function ProviderDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["provider", id],
    queryFn: () => api<Provider>(`/api/providers/${id}/`),
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
  return <Body provider={q.data} />
}

function Body({ provider: p }: { provider: Provider }) {
  const [tab, setTab] = useUrlTab<
    "overview" | "circuits" | "networks" | "journal" | "history"
  >("overview")
  const nav = useNavigate()
  const { canDo } = useMe()
  const [deleting, setDeleting] = useState<Provider | null>(null)
  const goBack = useCallback(() => nav({ to: "/providers" }), [nav])

  return (
    <DetailShell
      backTo="/providers"
      backLabel="Providers"
      title={p.name}
      presence={{ type: "provider", id: p.id }}
      actions={
        <>
          {canDo("provider", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/providers/$id/edit" params={{ id: p.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("provider", "delete") && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleting(p)}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          )}
        </>
      }
      hero={
        <>
          <DetailHero
            title={p.name}
            tags={p.tags.length > 0 && <TagList tags={p.tags} />}
            statCols={1}
            stats={
              <DetailStat
                label="Circuits"
                value={<span className="num">{p.circuit_count}</span>}
              />
            }
          />
          <CustomFieldValues model="provider" values={p.custom_fields} />
        </>
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "circuits", label: "Circuits", count: p.circuit_count },
        { value: "networks", label: "Networks" },
        { value: "journal", label: "Journal" },
        { value: "history", label: "History" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as typeof tab)}
    >
      <DetailTab value="overview">
        <ProviderOverview provider={p} />
      </DetailTab>
      <DetailTab value="circuits">
        <EmbeddedCircuitTable
          filter={{ provider: p.id }}
          omitProvider
          emptyText="No circuits for this provider yet."
        />
      </DetailTab>
      <DetailTab value="networks">
        <ProviderNetworksTable providerId={p.id} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.provider" objectId={p.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.provider" objectId={p.id} />
      </DetailTab>

      <ProviderDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

function ProviderOverview({ provider: p }: { provider: Provider }) {
  const { humanIds } = useMe()

  const details: KvRow[] = [
    ...(humanIds && p.numid != null
      ? [
          {
            label: "Number",
            value: <span className="num font-mono">#{p.numid}</span>,
          } satisfies KvRow,
        ]
      : []),
    {
      label: "Slug",
      value: <span className="font-mono text-[13px]">{p.slug}</span>,
      copy: p.slug,
    },
    {
      label: "Account",
      value: p.account ? (
        <span className="font-mono text-[13px]">{p.account}</span>
      ) : (
        dash
      ),
      copy: p.account || undefined,
    },
    {
      label: "Portal",
      value: p.portal_url ? (
        <a
          href={p.portal_url}
          target="_blank"
          rel="noreferrer"
          className="link inline-flex items-center gap-1"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          {p.portal_url.replace(/^https?:\/\//, "")}
        </a>
      ) : (
        dash
      ),
      copy: p.portal_url || undefined,
    },
    {
      label: "NOC email",
      value: p.noc_email ? (
        <a href={`mailto:${p.noc_email}`} className="link">
          {p.noc_email}
        </a>
      ) : (
        dash
      ),
      copy: p.noc_email || undefined,
    },
    {
      label: "NOC phone",
      value: p.noc_phone ? (
        <span className="font-mono text-[13px]">{p.noc_phone}</span>
      ) : (
        dash
      ),
      copy: p.noc_phone || undefined,
    },
  ]

  const record: KvRow[] = [
    { label: "Created", value: <TimeCell iso={p.created_at} /> },
    { label: "Updated", value: <TimeCell iso={p.updated_at} /> },
  ]

  const notes: KvRow[] = [
    {
      label: "Comments",
      value: p.comments ? (
        <span className="whitespace-pre-wrap">{p.comments}</span>
      ) : (
        dash
      ),
    },
  ]

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <KvCard title="Provider" rows={details} />
      <KvCard title="Record" rows={record} />
      <KvCard title="Notes" rows={notes} />
    </div>
  )
}

/** The provider's provider networks — the peering/transit fabrics it operates
 * that circuits terminate onto. */
function ProviderNetworksTable({ providerId }: { providerId: string }) {
  const q = useQuery({
    queryKey: ["provider-networks", "by-provider", providerId],
    queryFn: () =>
      api<Paginated<ProviderNetwork>>(
        `/api/provider-networks/?provider=${providerId}&page_size=500`
      ),
  })
  const rows = q.data?.results ?? []
  if (q.isError) return <QueryError error={q.error} />
  if (q.isLoading)
    return <p className="text-sm text-muted-foreground">Loading…</p>
  return (
    <SimpleTable<ProviderNetwork>
      data={rows}
      getRowKey={(r) => r.id}
      empty="No provider networks for this provider yet."
      columns={[
        {
          id: "name",
          header: "Name",
          flex: true,
          cell: (r) => (
            <Link
              to="/provider-networks/$id"
              params={{ id: r.id }}
              className="link font-medium"
            >
              {r.name}
            </Link>
          ),
        },
        {
          id: "service_id",
          header: "Service ID",
          cell: (r) => (
            <span className="font-mono text-xs">{r.service_id || "—"}</span>
          ),
        },
        {
          id: "circuits",
          header: "Circuits",
          align: "right",
          cell: (r) => <span className="num text-xs">{r.circuit_count}</span>,
        },
      ]}
    />
  )
}
