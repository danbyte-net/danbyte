import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type DeviceRole, type Paginated } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { useTableFilters } from "@/components/table-filters"
import { ListPageShell } from "@/components/list-page-shell"
import { buildDeviceRoleColumns } from "@/components/columns/device-role-columns"
import { DeviceRoleDeleteDialog } from "@/components/device-role-delete-dialog"
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
      buildDeviceRoleColumns<DeviceRole>({
        selection: true,
        humanIds,
        actions: {
          editTo: "/device-roles/$id/edit",
          editParams: (r) => ({ id: r.id }),
          canEdit: () => canEdit,
          onDelete: handleDelete,
          canDelete: () => canDelete,
        },
      }),
    [handleDelete, canEdit, canDelete, humanIds]
  )
  const { rail, filteredRows, snapshot, restore, activeCount } =
    useTableFilters(columns, rows)

  return (
    <ListPageShell
      title="Device roles"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      savedViews={{
        objectType: "devicerole",
        filters: { snapshot, restore, activeCount },
      }}
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
