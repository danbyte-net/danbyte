import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type PowerFeed, type Paginated } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader } from "@/components/data-table"
import { tagsColumn } from "@/components/cells/tag-list"
import { numidColumn } from "@/components/cells/numid"
import { RackCell } from "@/components/cells/rack-cell"
import { useTableFilters } from "@/components/table-filters"
import { ListPageShell } from "@/components/list-page-shell"
import { RowActions } from "@/components/row-actions"
import { PowerFeedDeleteDialog } from "@/components/power-feed-delete-dialog"
import { StatusBadge } from "@/components/status-badge"

function fmtPower(f: PowerFeed): string {
  if (f.voltage == null && f.amperage == null) return "—"
  const v = f.voltage != null ? `${f.voltage}V` : ""
  const a = f.amperage != null ? `${f.amperage}A` : ""
  return [v, a].filter(Boolean).join(" / ")
}

export const Route = createFileRoute("/power-feeds/")({
  component: PowerFeedsPage,
})

function PowerFeedsPage() {
  const { humanIds } = useMe()
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<PowerFeed | null>(null)

  const query = useQuery({
    queryKey: ["power-feeds", q],
    queryFn: () =>
      api<Paginated<PowerFeed>>(
        `/api/power-feeds/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })

  const rows = query.data?.results ?? []
  const onDelete = useCallback((f: PowerFeed) => setDeleting(f), [])
  const columns = useMemo<ColumnDef<PowerFeed>[]>(
    () => [
      ...(humanIds ? [numidColumn<PowerFeed>({ get: (r) => r.numid })] : []),
      {
        id: "name",
        accessorKey: "name",
        header: ({ column }) => <SortHeader column={column} label="Name" />,
        cell: ({ row }) => (
          <Link
            to="/power-feeds/$id/edit"
            params={{ id: row.original.id }}
            className="font-medium hover:underline"
          >
            {row.original.name}
          </Link>
        ),
      },
      {
        id: "panel",
        accessorFn: (f) => f.power_panel?.name ?? "",
        header: "Panel",
        cell: ({ row }) => (
          <span className="text-xs">
            {row.original.power_panel?.name ?? "—"}
          </span>
        ),
      },
      {
        id: "rack",
        accessorFn: (f) => f.rack?.name ?? "",
        header: "Rack",
        cell: ({ row }) => (
          <RackCell rack={row.original.rack} className="text-xs" />
        ),
      },
      {
        id: "status",
        accessorFn: (r) => r.status?.name ?? "",
        header: "Status",
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
        meta: {
          facet: {
            kind: "enum",
            label: "Status",
            get: (r: PowerFeed) => r.status?.id ?? "__none__",
            formatValue: (_v, r) => ({
              label: r.status?.name ?? "No status",
              color: r.status?.color,
            }),
          },
        },
      },
      {
        id: "type",
        accessorKey: "type",
        header: "Type",
        cell: ({ row }) => (
          <span className="text-xs">{row.original.type_display}</span>
        ),
        meta: {
          facet: {
            kind: "enum",
            label: "Type",
            get: (r: PowerFeed) => r.type,
            formatValue: (_v, sample) => ({ label: sample.type_display }),
          },
        },
      },
      {
        id: "supply",
        accessorKey: "supply",
        header: "Supply",
        cell: ({ row }) => (
          <span className="text-xs">{row.original.supply_display}</span>
        ),
        meta: {
          facet: {
            kind: "enum",
            label: "Supply",
            get: (r: PowerFeed) => r.supply,
            formatValue: (_v, sample) => ({ label: sample.supply_display }),
          },
        },
      },
      {
        id: "phase",
        accessorKey: "phase",
        header: "Phase",
        cell: ({ row }) => (
          <span className="text-xs">{row.original.phase_display}</span>
        ),
        meta: {
          facet: {
            kind: "enum",
            label: "Phase",
            get: (r: PowerFeed) => r.phase,
            formatValue: (_v, sample) => ({ label: sample.phase_display }),
          },
        },
      },
      {
        id: "power",
        header: "Power",
        cell: ({ row }) => (
          <span className="num text-xs">{fmtPower(row.original)}</span>
        ),
      },
      tagsColumn<PowerFeed>({ getTags: (r) => r.tags }),
      {
        id: "actions",
        enableHiding: false,
        cell: ({ row }) => (
          <RowActions
            editTo="/power-feeds/$id/edit"
            editParams={{ id: row.original.id }}
            onDelete={() => onDelete(row.original)}
          />
        ),
      },
    ],
    [onDelete, humanIds]
  )

  const { rail, filteredRows } = useTableFilters(columns, rows)

  return (
    <ListPageShell
      title="Power feeds"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      search={{ value: q, onChange: setQ, placeholder: "Filter feeds…" }}
      actions={
        <>
          <TableActions ioType="powerfeed" />
          <Button size="sm" asChild>
            <Link to="/power-feeds/new">Add feed</Link>
          </Button>
        </>
      }
      query={query}
    >
      <DataTable
        data={filteredRows}
        columns={columns}
        flexColumn="name"
        tableId="power-feeds"
      />
      <PowerFeedDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}
