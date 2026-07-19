import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { Pencil, Trash2 } from "lucide-react"
import { useCallback, useMemo, useState } from "react"

import { api, type Paginated, type RouteTarget, type VRF } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { TagList } from "@/components/cells/tag-list"
import { ColorBadge } from "@/components/cells/color-badge"
import { DataTable, SortHeader } from "@/components/data-table"
import { DetailShell, DetailTab } from "@/components/detail-shell"
import { KvCard, type KvRow } from "@/components/kv-card"
import { QueryError } from "@/components/query-error"
import { RtDeleteDialog } from "@/components/rt-delete-dialog"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"

import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/route-targets/$id")({
  component: RtDetail,
})

function RtDetail() {
  const { id } = Route.useParams()
  const rt = useQuery({
    queryKey: ["rt", id],
    queryFn: () => api<RouteTarget>(`/api/route-targets/${id}/`),
  })
  if (rt.isLoading)
    return <p className="p-6 text-sm text-muted-foreground">Loading…</p>
  if (rt.isError)
    return (
      <div className="p-6">
        <QueryError error={rt.error} />
      </div>
    )
  if (!rt.data) return null
  return <RtDetailBody rt={rt.data} />
}

function RtDetailBody({ rt: r }: { rt: RouteTarget }) {
  const [tab, setTab] = useState<"overview" | "vrfs" | "journal" | "history">(
    "overview"
  )
  const nav = useNavigate()
  const [deleting, setDeleting] = useState<RouteTarget | null>(null)
  const openDelete = useCallback(() => setDeleting(r), [r])
  const closeDelete = useCallback((o: boolean) => {
    if (!o) setDeleting(null)
  }, [])
  const goBack = useCallback(() => nav({ to: "/route-targets" }), [nav])

  return (
    <DetailShell
      backTo="/route-targets"
      backLabel="Route Targets"
      title={<span className="font-mono">{r.name}</span>}
      presence={{ type: "routetarget", id: r.id }}
      actions={
        <>
          <Button variant="outline" size="sm" asChild>
            <Link to="/route-targets/$id/edit" params={{ id: r.id }}>
              <Pencil className="h-3.5 w-3.5" /> Edit
            </Link>
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={openDelete}
          >
            <Trash2 className="h-3.5 w-3.5" /> Delete
          </Button>
        </>
      }
      hero={
        <section className="flex shrink-0 flex-wrap items-start gap-x-10 gap-y-4 border-b border-border px-6 py-5">
          <div className="min-w-0">
            <div className="font-mono text-3xl font-semibold tracking-tight">
              {r.name}
            </div>
            {r.tags.length > 0 && (
              <div className="mt-2">
                <TagList tags={r.tags} />
              </div>
            )}
            {r.description && (
              <p className="mt-3 max-w-2xl text-[13px] text-muted-foreground">
                {r.description}
              </p>
            )}
          </div>
        </section>
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "vrfs", label: "VRFs" },
        { value: "journal", label: "Journal" },
        { value: "history", label: "History" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as typeof tab)}
    >
      <DetailTab value="overview">
        <RtOverview rt={r} />
      </DetailTab>
      <DetailTab value="vrfs">
        <RtVrfsTable rtId={r.id} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.routetarget" objectId={r.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.routetarget" objectId={r.id} />
      </DetailTab>

      <RtDeleteDialog
        rt={deleting}
        onOpenChange={closeDelete}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

function RtVrfsTable({ rtId }: { rtId: string }) {
  const q = useQuery({
    queryKey: ["rt-vrfs", rtId],
    queryFn: () => api<Paginated<VRF>>(`/api/vrfs/?rt=${rtId}&page_size=500`),
  })
  const columns = useMemo<ColumnDef<VRF>[]>(
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: ({ column }) => <SortHeader column={column} label="VRF" />,
        cell: ({ row }) => (
          <Link
            to="/vrfs/$id"
            params={{ id: row.original.id }}
            className="hover:opacity-90"
          >
            <ColorBadge
              name={row.original.name}
              color={row.original.color || undefined}
            />
          </Link>
        ),
      },
      {
        id: "rd",
        accessorKey: "rd",
        header: "RD",
        cell: ({ row }) =>
          row.original.rd ? (
            <span className="font-mono text-xs">{row.original.rd}</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "direction",
        header: "Direction",
        enableSorting: false,
        cell: ({ row }) => {
          const isImport = row.original.import_targets.some(
            (t) => t.id === rtId
          )
          const isExport = row.original.export_targets.some(
            (t) => t.id === rtId
          )
          return (
            <div className="flex items-center gap-1.5 text-[11px]">
              {isImport && (
                <span className="rounded bg-muted px-1.5 py-0.5">imports</span>
              )}
              {isExport && (
                <span className="rounded bg-muted px-1.5 py-0.5">exports</span>
              )}
            </div>
          )
        },
      },
      {
        id: "prefixes",
        accessorKey: "prefix_count",
        header: "Prefixes",
        cell: ({ row }) => (
          <span className="num text-xs">{row.original.prefix_count}</span>
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
    ],
    [rtId]
  )

  if (q.isLoading)
    return <p className="text-sm text-muted-foreground">Loading VRFs…</p>
  if (q.isError) return <QueryError error={q.error} />
  const rows = q.data?.results ?? []
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No VRFs reference this RT.
      </p>
    )
  }
  return (
    <DataTable
      data={rows}
      columns={columns}
      flexColumn="description"
      embedded
    />
  )
}

/** Route-target identity/counts, moved out of the page header. */
function RtOverview({ rt: r }: { rt: RouteTarget }) {
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
      label: "Imported by",
      value: <span className="num">{r.import_vrf_count}</span>,
    },
    {
      label: "Exported by",
      value: <span className="num">{r.export_vrf_count}</span>,
    },
  ]
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <KvCard title="Details" rows={details} />
    </div>
  )
}
