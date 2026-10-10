import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api } from "@/lib/api"
import type { Paginated, VirtualMachineGroup } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { buildVmGroupColumns } from "@/components/columns/vm-group-columns"
import { useTableFilters } from "@/components/table-filters"
import { ListPageShell } from "@/components/list-page-shell"
import { TableActions } from "@/components/table-actions"
import { VmGroupDeleteDialog } from "@/components/vm-group-delete-dialog"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/vm-groups/")({
  component: VmGroupsPage,
})

function VmGroupsPage() {
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("virtualmachinegroup", "add")
  const canEdit = canDo("virtualmachinegroup", "change")
  const canDelete = canDo("virtualmachinegroup", "delete")
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<VirtualMachineGroup | null>(null)

  const query = useQuery({
    queryKey: ["vm-groups", q],
    queryFn: () =>
      api<Paginated<VirtualMachineGroup>>(
        `/api/vm-groups/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })

  const handleDelete = useCallback(
    (g: VirtualMachineGroup) => setDeleting(g),
    []
  )
  const columns = useMemo<ColumnDef<VirtualMachineGroup>[]>(
    () =>
      buildVmGroupColumns({
        selection: true,
        humanIds,
        actions: {
          editTo: "/vm-groups/$id/edit",
          editParams: (g) => ({ id: g.id }),
          canEdit: () => canEdit,
          onDelete: handleDelete,
          canDelete: () => canDelete,
        },
      }),
    [handleDelete, canEdit, canDelete, humanIds]
  )

  const allRows = query.data?.results ?? []
  const {
    rail,
    filteredRows,
    snapshot,
    restore,
    activeCount,
    columns: wiredColumns,
  } = useTableFilters(columns, allRows)

  return (
    <ListPageShell
      title="VM groups"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      savedViews={{
        objectType: "virtualmachinegroup",
        filters: { snapshot, restore, activeCount },
      }}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter by name, description…",
      }}
      actions={
        <>
          <TableActions ioType="virtualmachinegroup" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/vm-groups/new">Add VM group</Link>
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
        tableId="vm-groups"
      />
      <VmGroupDeleteDialog
        group={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}
