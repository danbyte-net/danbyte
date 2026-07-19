import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type Paginated, type Platform } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader, selectionColumn } from "@/components/data-table"
import { useTableFilters } from "@/components/table-filters"
import { ListPageShell } from "@/components/list-page-shell"
import { numidColumn } from "@/components/cells/numid"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { lifecycleColumn } from "@/components/cells/lifecycle-cell"
import { PlatformDeleteDialog } from "@/components/platform-delete-dialog"
import { RowActions } from "@/components/row-actions"
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
  const columns = useMemo<ColumnDef<Platform>[]>(
    () =>
      buildColumns({ onDelete: handleDelete, canEdit, canDelete, humanIds }),
    [handleDelete, canEdit, canDelete, humanIds]
  )
  const { rail, filteredRows } = useTableFilters(columns, rows)

  return (
    <ListPageShell
      title="Platforms"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
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
        columns={columns}
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

function buildColumns({
  onDelete,
  canEdit,
  canDelete,
  humanIds,
}: {
  onDelete: (p: Platform) => void
  canEdit: boolean
  canDelete: boolean
  humanIds: boolean
}): ColumnDef<Platform>[] {
  return [
    selectionColumn<Platform>(),
    ...(humanIds ? [numidColumn<Platform>({ get: (r) => r.numid })] : []),
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <Link
          to="/platforms/$id"
          params={{ id: row.original.id }}
          className="font-medium hover:underline"
        >
          {row.original.name}
        </Link>
      ),
    },
    {
      id: "manufacturer",
      accessorFn: (r) => r.manufacturer?.name ?? "",
      header: ({ column }) => (
        <SortHeader column={column} label="Manufacturer" />
      ),
      cell: ({ row }) =>
        row.original.manufacturer ? (
          <Link
            to="/manufacturers/$id"
            params={{ id: row.original.manufacturer.id }}
            className="text-xs text-primary hover:underline"
          >
            {row.original.manufacturer.name}
          </Link>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
      meta: {
        facet: {
          kind: "enum",
          label: "Manufacturer",
          get: (r: Platform) => r.manufacturer?.id ?? "__none__",
          formatValue: (_v, r) => ({
            label: r.manufacturer?.name ?? "No manufacturer",
          }),
        },
      },
    },
    {
      id: "devices",
      accessorKey: "device_count",
      header: ({ column }) => <SortHeader column={column} label="Devices" />,
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.device_count}</span>
      ),
    },
    lifecycleColumn<Platform>({ get: (r) => r, header: "OS lifecycle" }),
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
    timeAgoColumn<Platform>({
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
          editTo={canEdit ? "/platforms/$id/edit" : undefined}
          editParams={{ id: row.original.id }}
          onDelete={canDelete ? () => onDelete(row.original) : undefined}
        />
      ),
    },
  ]
}
