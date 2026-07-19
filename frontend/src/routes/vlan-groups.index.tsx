import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type Paginated, type VLANGroup } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader, selectionColumn } from "@/components/data-table"
import { useTableFilters } from "@/components/table-filters"
import { ListPageShell } from "@/components/list-page-shell"
import { numidColumn } from "@/components/cells/numid"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { VlanGroupDeleteDialog } from "@/components/vlan-group-delete-dialog"
import { RowActions } from "@/components/row-actions"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/vlan-groups/")({
  component: VlanGroupsPage,
})

function VlanGroupsPage() {
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("vlangroup", "add")
  const canEdit = canDo("vlangroup", "change")
  const canDelete = canDo("vlangroup", "delete")
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<VLANGroup | null>(null)

  const query = useQuery({
    queryKey: ["vlan-groups", q],
    queryFn: () =>
      api<Paginated<VLANGroup>>(
        `/api/vlan-groups/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })
  const rows = query.data?.results ?? []

  const handleDelete = useCallback((g: VLANGroup) => setDeleting(g), [])
  const columns = useMemo<ColumnDef<VLANGroup>[]>(
    () =>
      buildColumns({ onDelete: handleDelete, canEdit, canDelete, humanIds }),
    [handleDelete, canEdit, canDelete, humanIds]
  )
  const { rail, filteredRows } = useTableFilters(columns, rows)

  return (
    <ListPageShell
      title="VLAN groups"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      search={{ value: q, onChange: setQ, placeholder: "Filter…" }}
      actions={
        <>
          <TableActions ioType="vlangroup" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/vlan-groups/new">Add group</Link>
            </Button>
          )}
        </>
      }
      query={query}
    >
      <DataTable
        data={filteredRows}
        columns={columns}
        flexColumn="description"
        tableId="vlan-groups"
      />
      <VlanGroupDeleteDialog
        group={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}

function buildColumns({
  onDelete,
  canEdit,
  canDelete,
  humanIds,
}: {
  onDelete: (g: VLANGroup) => void
  canEdit: boolean
  canDelete: boolean
  humanIds: boolean
}): ColumnDef<VLANGroup>[] {
  return [
    selectionColumn<VLANGroup>(),
    ...(humanIds ? [numidColumn<VLANGroup>({ get: (r) => r.numid })] : []),
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <Link
          to="/vlan-groups/$id"
          params={{ id: row.original.id }}
          className="font-medium hover:underline"
        >
          {row.original.name}
        </Link>
      ),
    },
    {
      id: "range",
      header: "VID range",
      enableSorting: false,
      cell: ({ row }) => (
        <span className="num font-mono text-xs">
          {row.original.min_vid}–{row.original.max_vid}
        </span>
      ),
    },
    {
      id: "site",
      header: "Site",
      enableSorting: false,
      cell: ({ row }) =>
        row.original.site ? (
          <span className="text-xs">{row.original.site.name}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
      meta: {
        facet: {
          kind: "enum",
          label: "Site",
          get: (r: VLANGroup) => r.site?.id ?? "__none__",
          formatValue: (_v, s) => ({ label: s.site?.name ?? "No site" }),
        },
      },
    },
    {
      id: "cluster",
      header: "Cluster",
      enableSorting: false,
      cell: ({ row }) =>
        row.original.cluster ? (
          <span className="text-xs">{row.original.cluster.name}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
      meta: {
        facet: {
          kind: "enum",
          label: "Cluster",
          get: (r: VLANGroup) => r.cluster?.id ?? "__none__",
          formatValue: (_v, s) => ({ label: s.cluster?.name ?? "No cluster" }),
        },
      },
    },
    {
      id: "vlans",
      accessorKey: "vlan_count",
      header: ({ column }) => <SortHeader column={column} label="VLANs" />,
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.vlan_count}</span>
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
    timeAgoColumn<VLANGroup>({
      id: "updated",
      header: "Updated",
      get: (r) => r.updated_at,
      align: "right",
    }),
    {
      id: "actions",
      enableHiding: false,
      cell: ({ row }) => (
        <RowActions
          editTo={canEdit ? "/vlan-groups/$id/edit" : undefined}
          editParams={{ id: row.original.id }}
          onDelete={canDelete ? () => onDelete(row.original) : undefined}
        />
      ),
    },
  ]
}
