import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { Pencil, Trash2 } from "lucide-react"
import { useCallback, useMemo, useState } from "react"

import { api, type Aggregate, type Paginated, type RIR } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader } from "@/components/data-table"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { QueryError } from "@/components/query-error"
import { RirDeleteDialog } from "@/components/rir-delete-dialog"
import { DetailShell, DetailStat, DetailTab } from "@/components/detail-shell"
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
  const [tab, setTab] = useState<"aggregates" | "journal" | "history">(
    "aggregates"
  )
  const { humanIds } = useMe()
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
          <Button variant="outline" size="sm" asChild>
            <Link to="/rirs/$id/edit" params={{ id: r.id }}>
              <Pencil className="h-3.5 w-3.5" /> Edit
            </Link>
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={() => setDeleting(r)}
          >
            <Trash2 className="h-3.5 w-3.5" /> Delete
          </Button>
        </>
      }
      hero={
        <section className="flex shrink-0 flex-wrap items-start gap-x-10 gap-y-4 border-b border-border px-6 py-5">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-2xl font-semibold tracking-tight">
                {r.name}
              </span>
              {r.is_private ? (
                <Badge variant="secondary">Private</Badge>
              ) : (
                <Badge variant="success">Public</Badge>
              )}
            </div>
            {r.description && (
              <p className="mt-3 max-w-2xl text-[13px] text-muted-foreground">
                {r.description}
              </p>
            )}
          </div>
          <dl className="ml-auto grid grid-cols-2 gap-x-8 gap-y-3 text-[13px]">
            {humanIds && r.numid != null && (
              <DetailStat
                label="Number"
                value={<span className="num font-mono">#{r.numid}</span>}
              />
            )}
            <DetailStat
              label="Aggregates"
              value={<span className="num">{r.aggregate_count}</span>}
            />
          </dl>
        </section>
      }
      tabs={[
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

function RirAggregatesTable({ rirId }: { rirId: string }) {
  const q = useQuery({
    queryKey: ["rir-aggregates", rirId],
    queryFn: () =>
      api<Paginated<Aggregate>>(`/api/aggregates/?rir=${rirId}&page_size=500`),
  })
  const columns = useMemo<ColumnDef<Aggregate>[]>(
    () => [
      {
        id: "prefix",
        accessorKey: "prefix",
        header: ({ column }) => <SortHeader column={column} label="Prefix" />,
        cell: ({ row }) => (
          <Link
            to="/aggregates/$id"
            params={{ id: row.original.id }}
            className="font-mono font-medium hover:underline"
          >
            {row.original.prefix}
          </Link>
        ),
      },
      {
        id: "description",
        accessorKey: "description",
        header: "Description",
        cell: ({ row }) => (
          <span className="line-clamp-1 block text-muted-foreground">
            {row.original.description || "—"}
          </span>
        ),
      },
      timeAgoColumn<Aggregate>({
        id: "updated",
        header: "Updated",
        get: (r) => r.updated_at,
        align: "right",
      }),
    ],
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
