import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { CustomFieldValues } from "@/components/custom-field-display"
import { useUrlTab } from "@/lib/use-url-tab"
import { useQuery } from "@tanstack/react-query"
import { Pencil, Trash2 } from "lucide-react"
import { useCallback, useMemo, useState } from "react"

import { api, type Aggregate, type Paginated, type Prefix } from "@/lib/api"
import { buildPrefixColumns } from "@/components/columns/prefix-columns"
import { DataTable } from "@/components/data-table"
import type { ColumnDef } from "@tanstack/react-table"
import { TagList } from "@/components/cells/tag-list"
import { Button } from "@/components/ui/button"
import { KvCard, type KvRow } from "@/components/kv-card"
import { QueryError } from "@/components/query-error"
import { UtilCell } from "@/components/cells/util-cell"
import { AggregateDeleteDialog } from "@/components/aggregate-delete-dialog"
import {
  DetailHero,
  DetailShell,
  DetailStat,
  DetailTab,
} from "@/components/detail-shell"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/aggregates/$id")({
  component: AggregateDetail,
})

function AggregateDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["aggregate", id],
    queryFn: () => api<Aggregate>(`/api/aggregates/${id}/`),
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
  return <Body aggregate={q.data} />
}

function Body({ aggregate: a }: { aggregate: Aggregate }) {
  const [tab, setTab] = useUrlTab<
    "overview" | "prefixes" | "journal" | "history"
  >("overview")
  const nav = useNavigate()
  const [deleting, setDeleting] = useState<Aggregate | null>(null)
  const goBack = useCallback(() => nav({ to: "/aggregates" }), [nav])
  const { canDo } = useMe()
  // The prefixes carved inside this aggregate (#133) - fetched up front so
  // the tab wears its count.
  const children = useQuery({
    queryKey: ["aggregate-prefixes", a.id],
    queryFn: () =>
      api<Paginated<Prefix>>(
        `/api/prefixes/?contained_in=${encodeURIComponent(a.prefix)}&page_size=500`
      ),
  })

  return (
    <DetailShell
      backTo="/aggregates"
      backLabel="Aggregates"
      title={<span className="font-mono">{a.prefix}</span>}
      presence={{ type: "aggregate", id: a.id }}
      actions={
        <>
          {canDo("aggregate", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/aggregates/$id/edit" params={{ id: a.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("aggregate", "delete") && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleting(a)}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          )}
        </>
      }
      hero={
        <DetailHero
          title={a.prefix}
          mono
          badges={
            a.rir && (
              <Link
                to="/rirs/$id"
                params={{ id: a.rir.id }}
                className="link text-sm"
              >
                {a.rir.name}
              </Link>
            )
          }
          tags={a.tags.length > 0 && <TagList tags={a.tags} />}
          description={a.description}
          statCols={1}
          stats={
            <DetailStat
              label="Utilisation"
              value={<UtilCell pct={a.utilisation_pct} />}
            />
          }
        />
      }
      tabs={[
        { value: "overview", label: "Overview" },
        {
          value: "prefixes",
          label: "Prefixes",
          count: children.data?.count,
        },
        { value: "journal", label: "Journal" },
        { value: "history", label: "Change log" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as typeof tab)}
    >
      <DetailTab value="overview">
        <AggregateOverview aggregate={a} />
      </DetailTab>
      <DetailTab value="prefixes">
        <AggregatePrefixes aggregate={a} rows={children.data?.results ?? []} loading={children.isLoading} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.aggregate" objectId={a.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.aggregate" objectId={a.id} />
      </DetailTab>

      <AggregateDeleteDialog
        aggregate={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

/** Aggregate attributes, moved out of the page header. */
function AggregateOverview({ aggregate: a }: { aggregate: Aggregate }) {
  const { humanIds } = useMe()
  const details: KvRow[] = [
    ...(humanIds && a.numid != null
      ? [
          {
            label: "Number",
            value: <span className="num font-mono">#{a.numid}</span>,
          } satisfies KvRow,
        ]
      : []),
    {
      label: "Family",
      value: <span className="num">{a.family ? `IPv${a.family}` : "-"}</span>,
    },
    {
      label: "Date added",
      value: <span className="num text-xs">{a.date_added ?? "-"}</span>,
    },
  ]
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <KvCard title="Details" rows={details} />
      <CustomFieldValues
        model="aggregate"
        values={a.custom_fields}
        layout="cards"
      />
    </div>
  )
}


function AggregatePrefixes({
  aggregate,
  rows,
  loading,
}: {
  aggregate: Aggregate
  rows: Prefix[]
  loading: boolean
}) {
  const columns = useMemo<ColumnDef<Prefix>[]>(() => buildPrefixColumns({}), [])
  if (loading)
    return <p className="text-sm text-muted-foreground">Loading prefixes…</p>
  if (rows.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        No prefixes inside {aggregate.prefix} yet.
      </p>
    )
  return (
    <DataTable
      data={rows}
      columns={columns}
      flexColumn="description"
      tableId="prefix-embedded"
    />
  )
}
