import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { Pencil, Trash2 } from "lucide-react"
import { useCallback, useState } from "react"

import { api } from "@/lib/api"
import type { TunnelGroup } from "@/lib/api"
import { useUrlTab } from "@/lib/use-url-tab"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { TimeCell } from "@/components/cells/time-ago"
import { KvCard, dash } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { QueryError } from "@/components/query-error"
import { TunnelGroupDeleteDialog } from "@/components/tunnel-group-delete-dialog"
import {
  DetailHero,
  DetailShell,
  DetailStat,
  DetailTab,
} from "@/components/detail-shell"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { EmbeddedTunnelTable } from "@/components/embedded-tables"

export const Route = createFileRoute("/tunnel-groups/$id")({
  component: TunnelGroupDetail,
})

function TunnelGroupDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["tunnel-group", id],
    queryFn: () => api<TunnelGroup>(`/api/tunnel-groups/${id}/`),
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
  return <Body group={q.data} />
}

function Body({ group: g }: { group: TunnelGroup }) {
  const [tab, setTab] = useUrlTab<
    "overview" | "tunnels" | "journal" | "history"
  >("overview")
  const nav = useNavigate()
  const { canDo } = useMe()
  const [deleting, setDeleting] = useState<TunnelGroup | null>(null)
  const goBack = useCallback(() => nav({ to: "/tunnel-groups" }), [nav])

  return (
    <DetailShell
      backTo="/tunnel-groups"
      backLabel="Tunnel groups"
      title={g.name}
      presence={{ type: "tunnelgroup", id: g.id }}
      actions={
        <>
          {canDo("tunnelgroup", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/tunnel-groups/$id/edit" params={{ id: g.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("tunnelgroup", "delete") && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleting(g)}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          )}
        </>
      }
      hero={
        <DetailHero
          title={g.name}
          description={g.description}
          statCols={1}
          stats={
            <DetailStat
              label="Tunnels"
              value={<span className="num">{g.tunnel_count}</span>}
            />
          }
        />
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "tunnels", label: "Tunnels", count: g.tunnel_count },
        { value: "journal", label: "Journal" },
        { value: "history", label: "History" },
      ]}
      tab={tab}
      onTabChange={setTab}
    >
      <DetailTab value="overview">
        <TunnelGroupOverview group={g} />
      </DetailTab>
      <DetailTab value="tunnels">
        <EmbeddedTunnelTable
          filter={{ group: g.id }}
          omitGroup
          emptyText="No tunnels belong to this group yet."
        />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.tunnelgroup" objectId={g.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.tunnelgroup" objectId={g.id} />
      </DetailTab>

      <TunnelGroupDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

/** Tunnel-group attributes. The name, description and tunnel count stay in the
 * hero; everything else lands here. */
function TunnelGroupOverview({ group: g }: { group: TunnelGroup }) {
  const { humanIds } = useMe()

  const details: KvRow[] = [
    ...(humanIds && g.numid != null
      ? [
          {
            label: "Number",
            value: <span className="num font-mono">#{g.numid}</span>,
          } satisfies KvRow,
        ]
      : []),
    { label: "Name", value: g.name, copy: g.name },
    {
      label: "Slug",
      value: <span className="font-mono text-[13px]">{g.slug}</span>,
      copy: g.slug,
    },
    { label: "Description", value: g.description || dash },
    { label: "Tunnels", value: <span className="num">{g.tunnel_count}</span> },
  ]

  const record: KvRow[] = [
    { label: "Created", value: <TimeCell iso={g.created_at} /> },
    { label: "Updated", value: <TimeCell iso={g.updated_at} /> },
  ]

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <KvCard title="Tunnel group" rows={details} />
      <KvCard title="Record" rows={record} />
    </div>
  )
}
