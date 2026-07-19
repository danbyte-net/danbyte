import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type Tunnel, type Paginated } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader, selectionColumn } from "@/components/data-table"
import { tagsColumn } from "@/components/cells/tag-list"
import { useTableFilters } from "@/components/table-filters"
import { ListPageShell } from "@/components/list-page-shell"
import { numidColumn } from "@/components/cells/numid"
import { RowActions } from "@/components/row-actions"
import { TunnelDeleteDialog } from "@/components/tunnel-delete-dialog"
import { TunnelBulkBar } from "@/components/tunnel-bulk-bar"
import { StatusBadge } from "@/components/status-badge"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/tunnels/")({ component: TunnelsPage })

function TunnelsPage() {
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<Tunnel | null>(null)
  const [selectedRows, setSelectedRows] = useState<Tunnel[]>([])
  const { humanIds } = useMe()

  const query = useQuery({
    queryKey: ["tunnels", q],
    queryFn: () =>
      api<Paginated<Tunnel>>(
        `/api/tunnels/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })

  const rows = query.data?.results ?? []
  const onDelete = useCallback((t: Tunnel) => setDeleting(t), [])
  const columns = useMemo<ColumnDef<Tunnel>[]>(
    () => [
      selectionColumn<Tunnel>(),
      ...(humanIds ? [numidColumn<Tunnel>({ get: (r) => r.numid })] : []),
      {
        id: "name",
        accessorKey: "name",
        header: ({ column }) => <SortHeader column={column} label="Name" />,
        cell: ({ row }) => (
          <Link
            to="/tunnels/$id"
            params={{ id: row.original.id }}
            className="font-medium hover:underline"
          >
            {row.original.name}
          </Link>
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
            get: (r: Tunnel) => r.status?.id ?? "__none__",
            formatValue: (_v, r) => ({
              label: r.status?.name ?? "No status",
              color: r.status?.color,
            }),
          },
        },
      },
      {
        id: "encapsulation",
        accessorKey: "encapsulation",
        header: "Encapsulation",
        cell: ({ row }) => (
          <span className="text-xs">{row.original.encapsulation_display}</span>
        ),
        meta: {
          facet: {
            kind: "enum",
            label: "Encapsulation",
            get: (r: Tunnel) => r.encapsulation,
            formatValue: (_v, sample) => ({
              label: sample.encapsulation_display,
            }),
          },
        },
      },
      {
        id: "group",
        accessorFn: (t) => t.group?.name ?? "",
        header: "Group",
        cell: ({ row }) => (
          <span className="text-xs">{row.original.group?.name ?? "—"}</span>
        ),
        meta: {
          facet: {
            kind: "enum",
            label: "Group",
            get: (r: Tunnel) => r.group?.id ?? "__none__",
            formatValue: (_v, sample) => ({
              label: sample.group?.name ?? "No group",
            }),
          },
        },
      },
      {
        id: "profile",
        accessorFn: (t) => t.ipsec_profile?.name ?? "",
        header: "IPSec profile",
        cell: ({ row }) => (
          <span className="text-xs">
            {row.original.ipsec_profile?.name ?? "—"}
          </span>
        ),
      },
      {
        id: "tunnel_id",
        accessorKey: "tunnel_id",
        header: ({ column }) => <SortHeader column={column} label="ID" />,
        cell: ({ row }) =>
          row.original.tunnel_id != null ? (
            <span className="num font-mono text-xs">
              {row.original.tunnel_id}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      tagsColumn<Tunnel>({ getTags: (r) => r.tags }),
      {
        id: "actions",
        enableHiding: false,
        cell: ({ row }) => (
          <RowActions
            editTo="/tunnels/$id/edit"
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
      title="Tunnels"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      search={{ value: q, onChange: setQ, placeholder: "Filter tunnels…" }}
      actions={
        <>
          <TableActions ioType="tunnel" />
          <Button size="sm" asChild>
            <Link to="/tunnels/new">Add tunnel</Link>
          </Button>
        </>
      }
      query={query}
    >
      <DataTable
        data={filteredRows}
        columns={columns}
        onSelectedRowsChange={setSelectedRows}
        flexColumn="name"
        tableId="tunnels"
      />
      <TunnelDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
      <TunnelBulkBar
        selected={selectedRows}
        onCleared={() => setSelectedRows([])}
      />
    </ListPageShell>
  )
}
