import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type DeviceType, type Paginated } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader, selectionColumn } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { tagsColumn } from "@/components/cells/tag-list"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { numidColumn } from "@/components/cells/numid"
import { ManufacturerCell } from "@/components/cells/manufacturer-cell"
import { lifecycleColumn } from "@/components/cells/lifecycle-cell"
import {
  FilterRail,
  FacetGroup,
  toggleInSet,
  type FacetOption,
} from "@/components/filter-rail"
import { DeviceTypeDeleteDialog } from "@/components/device-type-delete-dialog"
import { DeviceTypeImportDialog } from "@/components/device-type-import-dialog"
import { LocalityBadge } from "@/components/locality-badge"
import { RowActions } from "@/components/row-actions"
import { useMe, objCan } from "@/lib/use-me"

export const Route = createFileRoute("/device-types/")({
  component: DeviceTypesPage,
})

function DeviceTypesPage() {
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("devicetype", "add")
  const canEdit = canDo("devicetype", "change")
  const canDelete = canDo("devicetype", "delete")
  const [q, setQ] = useState("")
  const [mfrFilter, setMfrFilter] = useState<Set<string>>(new Set())
  const [deleting, setDeleting] = useState<DeviceType | null>(null)
  const [importing, setImporting] = useState(false)

  const query = useQuery({
    queryKey: ["device-types", q],
    queryFn: () =>
      api<Paginated<DeviceType>>(
        `/api/device-types/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })
  const allRows = query.data?.results ?? []

  const rows = useMemo(
    () =>
      allRows.filter(
        (d) =>
          mfrFilter.size === 0 ||
          (d.manufacturer && mfrFilter.has(d.manufacturer.id))
      ),
    [allRows, mfrFilter]
  )

  const facets = useMemo(() => {
    const c: Record<string, { name: string; count: number }> = {}
    for (const d of allRows) {
      const key = d.manufacturer?.id ?? "none"
      const name = d.manufacturer?.name ?? "No manufacturer"
      if (!c[key]) c[key] = { name, count: 0 }
      c[key].count++
    }
    return Object.entries(c)
      .sort(([, a], [, b]) => b.count - a.count)
      .map<FacetOption>(([id, v]) => ({
        value: id,
        label: v.name,
        count: v.count,
      }))
  }, [allRows])

  const handleDelete = useCallback((d: DeviceType) => setDeleting(d), [])
  const columns = useMemo<ColumnDef<DeviceType>[]>(
    () =>
      buildColumns({ onDelete: handleDelete, canEdit, canDelete, humanIds }),
    [handleDelete, canEdit, canDelete, humanIds]
  )

  return (
    <ListPageShell
      title="Device types"
      count={query.data ? rows.length : undefined}
      rail={
        <FilterRail>
          <FacetGroup
            label="Manufacturer"
            options={facets}
            selected={mfrFilter}
            onToggle={(v) => toggleInSet(mfrFilter, v, setMfrFilter)}
          />
        </FilterRail>
      }
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter by name, model…",
      }}
      actions={
        <>
          <TableActions ioType="devicetype" />
          {canAdd && (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setImporting(true)}
              >
                Import
              </Button>
              <Button size="sm" asChild>
                <Link to="/device-types/new">Add device type</Link>
              </Button>
            </>
          )}
        </>
      }
      query={query}
    >
      <DataTable
        data={rows}
        columns={columns}
        flexColumn="description"
        tableId="device-types"
      />
      <DeviceTypeDeleteDialog
        deviceType={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
      <DeviceTypeImportDialog open={importing} onOpenChange={setImporting} />
    </ListPageShell>
  )
}

function buildColumns({
  onDelete,
  canEdit,
  canDelete,
  humanIds,
}: {
  onDelete: (d: DeviceType) => void
  canEdit: boolean
  canDelete: boolean
  humanIds: boolean
}): ColumnDef<DeviceType>[] {
  return [
    selectionColumn<DeviceType>(),
    ...(humanIds ? [numidColumn<DeviceType>({ get: (r) => r.numid })] : []),
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <Link
          to="/device-types/$id"
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
      cell: ({ row }) => (
        <ManufacturerCell manufacturer={row.original.manufacturer} />
      ),
    },
    {
      id: "model",
      accessorKey: "model",
      header: "Model",
      cell: ({ row }) =>
        row.original.model ? (
          <span className="font-mono text-xs">{row.original.model}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "u_height",
      accessorKey: "u_height",
      header: ({ column }) => <SortHeader column={column} label="U" />,
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.u_height}U</span>
      ),
    },
    {
      id: "devices",
      accessorKey: "device_count",
      header: ({ column }) => <SortHeader column={column} label="Devices" />,
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.device_count}</span>
      ),
    },
    lifecycleColumn<DeviceType>({ get: (r) => r }),
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
    tagsColumn<DeviceType>({
      getTags: (r) => r.tags,
      activeSlugs: new Set<string>(),
      onToggle: () => {},
    }),
    timeAgoColumn<DeviceType>({
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
              ? "/device-types/$id/edit"
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
