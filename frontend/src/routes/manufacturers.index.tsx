import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type Manufacturer, type Paginated } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader, selectionColumn } from "@/components/data-table"
import { useTableFilters } from "@/components/table-filters"
import { ListPageShell } from "@/components/list-page-shell"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { numidColumn } from "@/components/cells/numid"
import { LocalityBadge } from "@/components/locality-badge"
import { ManufacturerDeleteDialog } from "@/components/manufacturer-delete-dialog"
import { RowActions } from "@/components/row-actions"
import { useMe, objCan } from "@/lib/use-me"

export const Route = createFileRoute("/manufacturers/")({
  component: ManufacturersPage,
})

function ManufacturersPage() {
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<Manufacturer | null>(null)
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("manufacturer", "add")
  const canEdit = canDo("manufacturer", "change")
  const canDelete = canDo("manufacturer", "delete")

  const query = useQuery({
    queryKey: ["manufacturers", q],
    queryFn: () =>
      api<Paginated<Manufacturer>>(
        `/api/manufacturers/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })
  const rows = query.data?.results ?? []

  const handleDelete = useCallback((m: Manufacturer) => setDeleting(m), [])
  const columns = useMemo<ColumnDef<Manufacturer>[]>(
    () =>
      buildColumns({ onDelete: handleDelete, canEdit, canDelete, humanIds }),
    [handleDelete, canEdit, canDelete, humanIds]
  )
  // Columns declare their own filterability via meta.facet.
  const { rail, filteredRows } = useTableFilters(columns, rows)

  return (
    <ListPageShell
      title="Manufacturers"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter by name, description…",
      }}
      actions={
        <>
          <TableActions ioType="manufacturer" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/manufacturers/new">Add manufacturer</Link>
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
        tableId="manufacturers"
      />
      <ManufacturerDeleteDialog
        manufacturer={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}

function buildColumns({
  onDelete,
  canEdit,
  canDelete,
  humanIds,
}: {
  onDelete: (m: Manufacturer) => void
  canEdit: boolean
  canDelete: boolean
  humanIds: boolean
}): ColumnDef<Manufacturer>[] {
  return [
    selectionColumn<Manufacturer>(),
    ...(humanIds ? [numidColumn<Manufacturer>({ get: (r) => r.numid })] : []),
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <Link
          to="/manufacturers/$id"
          params={{ id: row.original.id }}
          className="font-medium hover:underline"
        >
          {row.original.name}
        </Link>
      ),
    },
    {
      id: "types",
      accessorKey: "device_type_count",
      header: ({ column }) => (
        <SortHeader column={column} label="Device types" />
      ),
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.device_type_count}</span>
      ),
      meta: {
        facet: {
          kind: "enum",
          label: "Device types",
          get: (r: Manufacturer) => (r.device_type_count > 0 ? "with" : "none"),
          formatValue: (v) => ({
            label: v === "with" ? "Has device types" : "No device types",
          }),
        },
      },
    },
    {
      id: "url",
      accessorKey: "url",
      header: "URL",
      cell: ({ row }) =>
        row.original.url ? (
          <a
            href={row.original.url}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-primary hover:underline"
          >
            {row.original.url.replace(/^https?:\/\//, "")}
          </a>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
      meta: {
        facet: {
          kind: "enum",
          label: "Website",
          get: (r: Manufacturer) => (r.url ? "yes" : "no"),
          formatValue: (v) => ({
            label: v === "yes" ? "Has website" : "No website",
          }),
        },
      },
    },
    {
      id: "description",
      accessorKey: "description",
      header: "Description",
      cell: ({ row }) => (
        <span className="line-clamp-1 block text-muted-foreground">
          {row.original.description || "—"}
        </span>
      ),
    },
    {
      id: "scope",
      accessorFn: (r) => r.owning_site?.name ?? "",
      header: "Scope",
      cell: ({ row }) => (
        <LocalityBadge owningSite={row.original.owning_site} />
      ),
    },
    timeAgoColumn<Manufacturer>({
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
          editTo={
            objCan(row.original, "change", canEdit)
              ? "/manufacturers/$id/edit"
              : undefined
          }
          editParams={{ id: row.original.id }}
          onDelete={
            objCan(row.original, "delete", canDelete)
              ? () => onDelete(row.original)
              : undefined
          }
        />
      ),
    },
  ]
}
