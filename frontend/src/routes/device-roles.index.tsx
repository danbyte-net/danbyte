import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type DeviceRole, type Paginated } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader, selectionColumn } from "@/components/data-table"
import { useTableFilters } from "@/components/table-filters"
import { ListPageShell } from "@/components/list-page-shell"
import { ColorBadge } from "@/components/cells/color-badge"
import { numidColumn } from "@/components/cells/numid"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { DeviceRoleDeleteDialog } from "@/components/device-role-delete-dialog"
import { RowActions } from "@/components/row-actions"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/device-roles/")({
  component: DeviceRolesPage,
})

function DeviceRolesPage() {
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<DeviceRole | null>(null)
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("devicerole", "add")
  const canEdit = canDo("devicerole", "change")
  const canDelete = canDo("devicerole", "delete")

  const query = useQuery({
    queryKey: ["device-roles", q],
    queryFn: () =>
      api<Paginated<DeviceRole>>(
        `/api/device-roles/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })
  const rows = query.data?.results ?? []

  const handleDelete = useCallback((r: DeviceRole) => setDeleting(r), [])
  const columns = useMemo<ColumnDef<DeviceRole>[]>(
    () =>
      buildColumns({ onDelete: handleDelete, canEdit, canDelete, humanIds }),
    [handleDelete, canEdit, canDelete, humanIds]
  )
  const { rail, filteredRows } = useTableFilters(columns, rows)

  return (
    <ListPageShell
      title="Device roles"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter…",
      }}
      actions={
        <>
          <TableActions ioType="devicerole" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/device-roles/new">Add role</Link>
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
        tableId="device-roles"
      />
      <DeviceRoleDeleteDialog
        role={deleting}
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
  onDelete: (r: DeviceRole) => void
  canEdit: boolean
  canDelete: boolean
  humanIds: boolean
}): ColumnDef<DeviceRole>[] {
  return [
    selectionColumn<DeviceRole>(),
    ...(humanIds ? [numidColumn<DeviceRole>({ get: (r) => r.numid })] : []),
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <Link
          to="/device-roles/$id"
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
      id: "description",
      accessorKey: "description",
      header: "Description",
      cell: ({ row }) => (
        <span className="line-clamp-1 block text-muted-foreground">
          {row.original.description || "—"}
        </span>
      ),
    },
    {
      id: "devices",
      accessorKey: "device_count",
      header: ({ column }) => <SortHeader column={column} label="Devices" />,
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.device_count}</span>
      ),
      meta: {
        facet: {
          kind: "enum",
          label: "Usage",
          get: (r: DeviceRole) =>
            r.device_count + r.vm_count > 0 ? "in" : "out",
          formatValue: (v) => ({
            label: v === "in" ? "In use" : "Unused",
          }),
        },
      },
    },
    {
      id: "vms",
      accessorKey: "vm_count",
      header: ({ column }) => <SortHeader column={column} label="VMs" />,
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.vm_count}</span>
      ),
    },
    timeAgoColumn<DeviceRole>({
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
          editTo={canEdit ? "/device-roles/$id/edit" : undefined}
          editParams={{ id: row.original.id }}
          onDelete={canDelete ? () => onDelete(row.original) : undefined}
        />
      ),
    },
  ]
}
