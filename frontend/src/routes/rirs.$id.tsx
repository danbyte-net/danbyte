import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useUrlTab } from "@/lib/use-url-tab"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { Pencil, Trash2 } from "lucide-react"
import { useCallback, useMemo, useState } from "react"

import { api, type Aggregate, type Paginated, type RIR } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { buildAggregateColumns } from "@/components/columns/aggregate-columns"
import { TimeCell } from "@/components/cells/time-ago"
import { KvCard } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { QueryError } from "@/components/query-error"
import { RirDeleteDialog } from "@/components/rir-delete-dialog"
import {
  DetailHero,
  DetailShell,
  DetailStat,
  DetailTab,
} from "@/components/detail-shell"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"

import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/rirs/$id")({ component: RirDetail })

function RirDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["rir", id],
    queryFn: () => api<RIR>(`/api/rirs/${id}/`),
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
  return <Body rir={q.data} />
}

function Body({ rir: r }: { rir: RIR }) {
  const { canDo } = useMe()
  const [tab, setTab] = useUrlTab<
    "overview" | "aggregates" | "journal" | "history"
  >("overview")
  const nav = useNavigate()
  const [deleting, setDeleting] = useState<RIR | null>(null)
  const goBack = useCallback(() => nav({ to: "/rirs" }), [nav])

  return (
    <DetailShell
      backTo="/rirs"
      backLabel="RIRs"
      title={r.name}
      presence={{ type: "rir", id: r.id }}
      actions={
        <>
          {canDo("rir", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/rirs/$id/edit" params={{ id: r.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("rir", "delete") && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleting(r)}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          )}
        </>
      }
      hero={
        <DetailHero
          title={r.name}
          badges={
            r.is_private ? (
              <Badge variant="secondary">Private</Badge>
            ) : (
              <Badge variant="success">Public</Badge>
            )
          }
          description={r.description}
          stats={
            <DetailStat
              label="Aggregates"
              value={<span className="num">{r.aggregate_count}</span>}
            />
          }
        />
      }
      tabs={[
        { value: "overview", label: "Overview" },
        {
          value: "aggregates",
          label: "Aggregates",
          count: r.aggregate_count,
        },
        { value: "journal", label: "Journal" },
        { value: "history", label: "History" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as typeof tab)}
    >
      <DetailTab value="overview">
        <RirOverview rir={r} />
      </DetailTab>
      <DetailTab value="aggregates">
        <RirAggregatesTable rirId={r.id} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.rir" objectId={r.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.rir" objectId={r.id} />
      </DetailTab>

      <RirDeleteDialog
        rir={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

/** RIR attributes, moved out of the page header. Only the name, public/private
 * badge, description and aggregate count stay up top. */
function RirOverview({ rir: r }: { rir: RIR }) {
  const { humanIds } = useMe()

  const details: KvRow[] = [
    ...(humanIds && r.numid != null
      ? [
          {
            label: "Number",
            value: <span className="num font-mono">#{r.numid}</span>,
          } satisfies KvRow,
        ]
      : []),
    {
      label: "Slug",
      value: <span className="font-mono text-[13px]">{r.slug}</span>,
      copy: r.slug,
    },
    {
      label: "Space",
      value: r.is_private ? (
        <Badge variant="secondary">Private</Badge>
      ) : (
        <Badge variant="success">Public</Badge>
      ),
    },
    { label: "Created", value: <TimeCell iso={r.created_at} /> },
    { label: "Updated", value: <TimeCell iso={r.updated_at} /> },
  ]

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <KvCard title="RIR" rows={details} />
    </div>
  )
}

function RirAggregatesTable({ rirId }: { rirId: string }) {
  const q = useQuery({
    queryKey: ["rir-aggregates", rirId],
    queryFn: () =>
      api<Paginated<Aggregate>>(`/api/aggregates/?rir=${rirId}&page_size=500`),
  })
  const columns = useMemo<ColumnDef<Aggregate>[]>(
    () =>
      buildAggregateColumns({
        include: ["prefix", "description", "updated"],
      }),
    []
  )

  if (q.isLoading)
    return <p className="text-sm text-muted-foreground">Loading…</p>
  if (q.isError) return <QueryError error={q.error} />
  const rows = q.data?.results ?? []
  if (rows.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        No aggregates under this RIR.
      </p>
    )
  return (
    <DataTable
      data={rows}
      columns={columns}
      flexColumn="description"
      embedded
    />
  )
}
