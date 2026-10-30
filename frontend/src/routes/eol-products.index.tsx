import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import type { EolCustomProduct } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader } from "@/components/data-table"
import { useUrlTableFilters } from "@/components/table-filters"
import { ListPageShell } from "@/components/list-page-shell"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { useEolSettings } from "@/components/cells/eol-cell"
import { EolProductDeleteDialog } from "@/components/eol-product-delete-dialog"
import { RowActions } from "@/components/row-actions"
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
  const { canDo } = useMe()
  const settings = useEolSettings()
  const canAdd = canDo("eolproduct", "add")
  const canEdit = canDo("eolproduct", "change")
  const canDelete = canDo("eolproduct", "delete")

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
    () => eolProductColumns({ onDelete: handleDelete, canEdit, canDelete }),
    [handleDelete, canEdit, canDelete]
  )
  const {
    rail,
    filteredRows,
    columns: wiredColumns,
  } = useUrlTableFilters(columns, rows)

  return (
    <ListPageShell
      title="End-of-life products"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter by name, key, notes…",
      }}
      actions={
        canAdd && (
          <Button size="sm" asChild>
            <Link to="/eol-products/new">Add product</Link>
          </Button>
        )
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
      />
      <EolProductDeleteDialog
        product={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}

function eolProductColumns({
  onDelete,
  canEdit,
  canDelete,
}: {
  onDelete: (p: EolCustomProduct) => void
  canEdit: boolean
  canDelete: boolean
}): ColumnDef<EolCustomProduct>[] {
  return [
    {
      id: "label",
      accessorKey: "label",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <Link
          to="/eol-products/$id"
          params={{ id: row.original.id }}
          className="link font-medium"
        >
          {row.original.label}
        </Link>
      ),
    },
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Key" />,
      cell: ({ row }) => (
        <span className="font-mono text-xs">{row.original.name}</span>
      ),
    },
    {
      id: "cycles",
      accessorKey: "cycle_count",
      header: ({ column }) => <SortHeader column={column} label="Cycles" />,
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.cycle_count}</span>
      ),
    },
    {
      id: "applications",
      accessorKey: "application_count",
      header: ({ column }) => (
        <SortHeader column={column} label="Applications" />
      ),
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.application_count}</span>
      ),
    },
    {
      id: "platforms",
      accessorKey: "platform_count",
      header: ({ column }) => <SortHeader column={column} label="Platforms" />,
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.platform_count}</span>
      ),
    },
    {
      id: "notes",
      accessorKey: "notes",
      header: "Notes",
      cell: ({ row }) => (
        <span className="line-clamp-1 block text-muted-foreground">
          {row.original.notes || "-"}
        </span>
      ),
    },
    timeAgoColumn<EolCustomProduct>({
      id: "updated",
      header: "Updated",
      get: (r) => r.updated_at,
      align: "right",
    }),
    {
      id: "actions",
      enableHiding: false,
      cell: ({ row }) => (
        <RowActions
          editTo={canEdit ? "/eol-products/$id/edit" : undefined}
          editParams={{ id: row.original.id }}
          onDelete={canDelete ? () => onDelete(row.original) : undefined}
        />
      ),
    },
  ]
}
