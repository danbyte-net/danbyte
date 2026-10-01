import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api } from "@/lib/api"
import type { CabinetRole, Paginated } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { buildCabinetRoleColumns } from "@/components/columns/cabinet-role-columns"
import { CabinetRoleDeleteDialog } from "@/components/cabinet-role-delete-dialog"
import { ListPageShell } from "@/components/list-page-shell"
import { TableActions } from "@/components/table-actions"
import { useTableFilters } from "@/components/table-filters"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/cabinet-roles/")({
  component: CabinetRolesPage,
})

function CabinetRolesPage() {
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<CabinetRole | null>(null)
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("cabinetrole", "add")
  const canEdit = canDo("cabinetrole", "change")
  const canDelete = canDo("cabinetrole", "delete")

  const query = useQuery({
    queryKey: ["cabinet-roles", q],
    queryFn: () =>
      api<Paginated<CabinetRole>>(
        `/api/cabinet-roles/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })
  const rows = query.data?.results ?? []

  const handleDelete = useCallback((r: CabinetRole) => setDeleting(r), [])
  const columns = useMemo<ColumnDef<CabinetRole>[]>(
    () =>
      buildCabinetRoleColumns({
        selection: true,
        humanIds,
        actions: {
          editTo: "/cabinet-roles/$id/edit",
          editParams: (r) => ({ id: r.id }),
          canEdit: () => canEdit,
          onDelete: handleDelete,
          canDelete: () => canDelete,
        },
      }),
    [handleDelete, canEdit, canDelete, humanIds]
  )
  const {
    rail,
    filteredRows,
    snapshot,
    restore,
    activeCount,
    columns: wiredColumns,
  } = useTableFilters(columns, rows)

  return (
    <ListPageShell
      title="Cabinet roles"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      savedViews={{
        objectType: "cabinetrole",
        filters: { snapshot, restore, activeCount },
      }}
      search={{ value: q, onChange: setQ, placeholder: "Filter…" }}
      actions={
        <>
          <TableActions ioType="cabinetrole" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/cabinet-roles/new">Add role</Link>
            </Button>
          )}
        </>
      }
      query={query}
    >
      <DataTable
        data={filteredRows}
        columns={wiredColumns}
        flexColumn="description"
        tableId="cabinet-roles"
      />
      <CabinetRoleDeleteDialog
        role={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}
