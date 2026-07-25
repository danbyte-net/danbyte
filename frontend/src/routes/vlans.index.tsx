import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type Paginated, type VLAN } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { buildVlanColumns } from "@/components/columns/vlan-columns"
import { useTableFilters } from "@/components/table-filters"
import { ListPageShell } from "@/components/list-page-shell"
import { VlanDeleteDialog } from "@/components/vlan-delete-dialog"
import { VlanBulkBar } from "@/components/vlan-bulk-bar"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/vlans/")({ component: VlansPage })

function VlansPage() {
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("vlan", "add")
  const canEdit = canDo("vlan", "change")
  const canDelete = canDo("vlan", "delete")
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<VLAN | null>(null)
  const [selectedRows, setSelectedRows] = useState<VLAN[]>([])

  const query = useQuery({
    queryKey: ["vlans", q],
    queryFn: () =>
      api<Paginated<VLAN>>(
        `/api/vlans/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })

  const handleDelete = useCallback((v: VLAN) => setDeleting(v), [])

  const columns = useMemo<ColumnDef<VLAN>[]>(
    () =>
      buildVlanColumns<VLAN>({
        selection: true,
        humanIds,
        // The Group column belongs to the compliance/affected view; this list
        // has always shown Zone instead.
        omit: ["group"],
        violations: true,
        actions: {
          editTo: "/vlans/$id/edit",
          editParams: (v) => ({ id: v.id }),
          canEdit: () => canEdit,
          onDelete: handleDelete,
          canDelete: () => canDelete,
        },
      }),
    [handleDelete, canEdit, canDelete, humanIds]
  )

  const allRows = query.data?.results ?? []
  const { rail, filteredRows } = useTableFilters(columns, allRows)

  return (
    <ListPageShell
      title="VLANs"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter by ID, name, description…",
      }}
      actions={
        <>
          <TableActions ioType="vlan" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/vlans/new" search={{ vlan_id: undefined }}>
                Add VLAN
              </Link>
            </Button>
          )}
        </>
      }
      query={query}
    >
      <DataTable
        data={filteredRows}
        columns={columns}
        onSelectedRowsChange={setSelectedRows}
        flexColumn="description"
        tableId="vlans"
      />
      <VlanDeleteDialog
        vlan={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
      <VlanBulkBar
        selected={selectedRows}
        onCleared={() => setSelectedRows([])}
      />
    </ListPageShell>
  )
}
