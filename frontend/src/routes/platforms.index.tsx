import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { useCallback, useMemo, useState } from "react"

import { api, type Paginated, type Platform } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { buildPlatformColumns } from "@/components/columns/platform-columns"
import { useTableFilters } from "@/components/table-filters"
import { ListPageShell } from "@/components/list-page-shell"
import { PlatformDeleteDialog } from "@/components/platform-delete-dialog"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/platforms/")({
  component: PlatformsPage,
})

function PlatformsPage() {
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<Platform | null>(null)
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("platform", "add")
  const canEdit = canDo("platform", "change")
  const canDelete = canDo("platform", "delete")

  const query = useQuery({
    queryKey: ["platforms", q],
    queryFn: () =>
      api<Paginated<Platform>>(
        `/api/platforms/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })
  const rows = query.data?.results ?? []

  const handleDelete = useCallback((p: Platform) => setDeleting(p), [])
  const columns = useMemo(
    () =>
      buildPlatformColumns<Platform>({
        selection: true,
        humanIds,
        actions: {
          editTo: "/platforms/$id/edit",
          editParams: (p) => ({ id: p.id }),
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
      title="Platforms"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      savedViews={{
        objectType: "platform",
        filters: { snapshot, restore, activeCount },
      }}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter by name, description…",
      }}
      actions={
        <>
          <TableActions ioType="platform" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/platforms/new">Add platform</Link>
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
        tableId="platforms"
      />
      <PlatformDeleteDialog
        platform={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}

