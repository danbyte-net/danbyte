import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { useCallback, useMemo, useState } from "react"

import type { EolCustomProduct } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { useUrlTableFilters } from "@/components/table-filters"
import { ListPageShell } from "@/components/list-page-shell"
import { TableActions } from "@/components/table-actions"
import { buildEolProductColumns } from "@/components/columns/eol-product-columns"
import { useEolSettings } from "@/components/cells/eol-cell"
import { EolProductDeleteDialog } from "@/components/eol-product-delete-dialog"
import { SafeBulkEditBar } from "@/components/safe-bulk-edit-bar"
import { useMe } from "@/lib/use-me"
import { useUrlSearch } from "@/lib/url-filters"

export const Route = createFileRoute("/eol-products/")({
  component: EolProductsPage,
})

/** The tenant's own end-of-life products, for what the fetched catalog
 * lacks. Picked like any other product on platforms and applications. */
function EolProductsPage() {
  const [q, setQ] = useUrlSearch()
  const [deleting, setDeleting] = useState<EolCustomProduct | null>(null)
  const [selected, setSelected] = useState<EolCustomProduct[]>([])
  const { canDo } = useMe()
  const settings = useEolSettings()
  const canAdd = canDo("eolproduct", "add")
  const canEdit = canDo("eolproduct", "change")
  const canDelete = canDo("eolproduct", "delete")
  const selectable = canEdit || canDelete

  const query = useQuery({
    queryKey: ["eol-custom-products", q],
    queryFn: () =>
      apiAll<EolCustomProduct>(
        `/api/eol/custom-products/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })
  const rows = query.data?.results ?? []

  const handleDelete = useCallback((p: EolCustomProduct) => setDeleting(p), [])
  const columns = useMemo(
    () =>
      buildEolProductColumns<EolCustomProduct>({
        selection: selectable,
        actions: {
          editTo: "/eol-products/$id/edit",
          editParams: (p) => ({ id: p.id }),
          canEdit: () => canEdit,
          onDelete: handleDelete,
          canDelete: () => canDelete,
        },
      }),
    [handleDelete, canEdit, canDelete, selectable]
  )
  const {
    rail,
    filteredRows,
    snapshot,
    restore,
    activeCount,
    columns: wiredColumns,
  } = useUrlTableFilters(columns, rows)

  return (
    <ListPageShell
      title="End-of-life products"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      savedViews={{
        objectType: "eolproduct",
        filters: { snapshot, restore, activeCount },
      }}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter by name, key, notes…",
      }}
      actions={
        <>
          <TableActions ioType="eolproduct" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/eol-products/new">Add product</Link>
            </Button>
          )}
        </>
      }
      query={query}
    >
      {settings.data && !settings.enabled && (
        <p className="text-xs text-muted-foreground">
          End-of-life data is off.
        </p>
      )}
      <DataTable
        data={filteredRows}
        columns={wiredColumns}
        flexColumn="notes"
        tableId="eol-products"
        onSelectedRowsChange={selectable ? setSelected : undefined}
        selectedRows={selectable ? selected : undefined}
      />
      <SafeBulkEditBar
        selected={selected}
        endpoint="/api/eol/custom-products/"
        noun={["product", "products"]}
        invalidate={[["eol-custom-products"]]}
        onCleared={() => setSelected([])}
        canEdit={canEdit}
        canDelete={canDelete}
        ioType="eolproduct"
      />
      <EolProductDeleteDialog
        product={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}
