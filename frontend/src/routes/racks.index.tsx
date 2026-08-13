import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type Paginated, type Rack } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { buildRackColumns } from "@/components/columns/rack-columns"
import { ListPageShell } from "@/components/list-page-shell"
import { useTableFilters } from "@/components/table-filters"
import { RackDeleteDialog } from "@/components/rack-delete-dialog"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/racks/")({ component: RacksPage })

function RacksPage() {
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<Rack | null>(null)
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("rack", "add")
  const canEdit = canDo("rack", "change")
  const canDelete = canDo("rack", "delete")

  const query = useQuery({
    queryKey: ["racks", q],
    queryFn: () =>
      api<Paginated<Rack>>(
        `/api/racks/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })

  const handleDelete = useCallback((r: Rack) => setDeleting(r), [])
  const columns = useMemo<ColumnDef<Rack>[]>(
    () =>
      buildRackColumns({
        // "width"/"used" are the embedded rack pane's compact pair; this page
        // shows the fuller height / devices / utilisation trio instead.
        omit: ["width", "used"],
        selection: true,
        humanIds,
        actions: {
          editTo: "/racks/$id/edit",
          editParams: (r) => ({ id: r.id }),
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
      title="Racks"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      savedViews={{
        objectType: "rack",
        filters: { snapshot, restore, activeCount },
      }}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter by name, facility ID…",
      }}
      actions={
        <>
          <TableActions ioType="rack" />
          <Button size="sm" variant="outline" asChild>
            <Link to="/racks/elevations">Elevations</Link>
          </Button>
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/racks/new">Add rack</Link>
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
        tableId="racks"
      />
      <RackDeleteDialog
        rack={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}
