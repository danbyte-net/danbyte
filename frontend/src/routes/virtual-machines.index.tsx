import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type VirtualMachine, type Paginated } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { buildVmColumns } from "@/components/columns/vm-columns"
import { ListPageShell } from "@/components/list-page-shell"
import { useTableFilters } from "@/components/table-filters"
import { VmDeleteDialog } from "@/components/vm-delete-dialog"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/virtual-machines/")({
  component: VirtualMachinesPage,
  // ?device= narrows to the VMs running on one hypervisor host - the device
  // page's "Virtual machines" row links here (#54).
  validateSearch: (s: Record<string, unknown>) => ({
    device: typeof s.device === "string" ? s.device : undefined,
  }),
})

function VirtualMachinesPage() {
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("virtualmachine", "add")
  const canEdit = canDo("virtualmachine", "change")
  const canDelete = canDo("virtualmachine", "delete")
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<VirtualMachine | null>(null)
  const { device } = Route.useSearch()

  const query = useQuery({
    queryKey: ["virtual-machines", q, device],
    queryFn: () =>
      api<Paginated<VirtualMachine>>(
        `/api/virtual-machines/?${new URLSearchParams({
          search: q,
          ...(device ? { device } : {}),
        }).toString()}`
      ),
  })

  const handleDelete = useCallback((vm: VirtualMachine) => setDeleting(vm), [])

  const columns = useMemo<ColumnDef<VirtualMachine>[]>(
    () =>
      buildVmColumns({
        selection: true,
        humanIds,
        actions: {
          editTo: "/virtual-machines/$id/edit",
          editParams: (vm) => ({ id: vm.id }),
          canEdit: () => canEdit,
          onDelete: handleDelete,
          canDelete: () => canDelete,
        },
      }),
    [handleDelete, canEdit, canDelete, humanIds]
  )

  const allRows = query.data?.results ?? []
  const { rail, filteredRows, snapshot, restore, activeCount } =
    useTableFilters(columns, allRows)

  return (
    <ListPageShell
      title="Virtual machines"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      savedViews={{
        objectType: "virtualmachine",
        filters: { snapshot, restore, activeCount },
      }}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter by name, description…",
      }}
      actions={
        <>
          <TableActions ioType="virtualmachine" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/virtual-machines/new">Add VM</Link>
            </Button>
          )}
        </>
      }
      query={query}
    >
      <DataTable
        data={filteredRows}
        columns={columns}
        flexColumn="primary_ip"
        tableId="virtual-machines"
      />
      <VmDeleteDialog
        vm={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}
