import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api } from "@/lib/api"
import type { Cabinet, Paginated } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { buildCabinetColumns } from "@/components/columns/cabinet-columns"
import { CabinetDeleteDialog } from "@/components/cabinet-delete-dialog"
import { ListPageShell } from "@/components/list-page-shell"
import { TableActions } from "@/components/table-actions"
import { useTableFilters } from "@/components/table-filters"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/cabinets/")({ component: CabinetsPage })

function CabinetsPage() {
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<Cabinet | null>(null)
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("cabinet", "add")
  const canEdit = canDo("cabinet", "change")
  const canDelete = canDo("cabinet", "delete")

  const query = useQuery({
    queryKey: ["cabinets", q],
    queryFn: () =>
      api<Paginated<Cabinet>>(
        `/api/cabinets/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })

  const handleDelete = useCallback((c: Cabinet) => setDeleting(c), [])
  const columns = useMemo<ColumnDef<Cabinet>[]>(
    () =>
      buildCabinetColumns({
        // The facility ID stays in the Columns menu.
        omit: ["facility"],
        selection: true,
        humanIds,
        actions: {
          editTo: "/cabinets/$id/edit",
          editParams: (c) => ({ id: c.id }),
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
      title="Cabinets"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      savedViews={{
        objectType: "cabinet",
        filters: { snapshot, restore, activeCount },
      }}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter by name, facility ID…",
      }}
      actions={
        <>
          <TableActions ioType="cabinet" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/cabinets/new">Add cabinet</Link>
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
        tableId="cabinets"
      />
      <CabinetDeleteDialog
        cabinet={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}
