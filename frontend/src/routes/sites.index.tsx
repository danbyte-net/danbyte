import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type Paginated, type Site } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { buildSiteColumns } from "@/components/columns/site-columns"
import { ListPageShell } from "@/components/list-page-shell"
import { useTableFilters } from "@/components/table-filters"
import { SiteDeleteDialog } from "@/components/site-delete-dialog"
import { SiteBulkBar } from "@/components/site-bulk-bar"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/sites/")({ component: SitesPage })

function SitesPage() {
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<Site | null>(null)
  const [selectedRows, setSelectedRows] = useState<Site[]>([])
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("site", "add")
  const canEdit = canDo("site", "change")
  const canDelete = canDo("site", "delete")

  const query = useQuery({
    queryKey: ["sites", q],
    queryFn: () =>
      api<Paginated<Site>>(
        `/api/sites/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })

  const handleDelete = useCallback((s: Site) => setDeleting(s), [])

  // Columns declare their own filterability via meta.facet.
  const columns = useMemo<ColumnDef<Site>[]>(
    () =>
      buildSiteColumns<Site>({
        selection: true,
        humanIds,
        violations: true,
        actions: {
          editTo: "/sites/$id/edit",
          editParams: (s) => ({ id: s.id }),
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
      title="Sites"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter by name, location, description…",
      }}
      actions={
        <>
          <TableActions ioType="site" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/sites/new">Add Site</Link>
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
        tableId="sites"
      />
      <SiteDeleteDialog
        site={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
      <SiteBulkBar
        selected={selectedRows}
        onCleared={() => setSelectedRows([])}
      />
    </ListPageShell>
  )
}
