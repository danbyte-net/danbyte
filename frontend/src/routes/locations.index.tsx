import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { CornerDownRight } from "lucide-react"
import { useCallback, useMemo, useState } from "react"

import { api, type Location, type Paginated } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { nestByParent } from "@/lib/nest"
import { numidColumn } from "@/components/cells/numid"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader } from "@/components/data-table"
import { useTableFilters } from "@/components/table-filters"
import { ListPageShell } from "@/components/list-page-shell"
import { RowActions } from "@/components/row-actions"
import { LocationDeleteDialog } from "@/components/location-delete-dialog"
import { siteColumn } from "@/components/cells/site-cell"
import { LocationCell } from "@/components/cells/location-cell"
import { StatusBadge } from "@/components/status-badge"
import { TileBadge } from "@/components/floorplan/tile-badge"

export const Route = createFileRoute("/locations/")({
  component: LocationsPage,
})

// Depth-first tree order + `_depth` markers - shared with the Regions list
// (frontend/src/lib/nest.ts), same treatment as the prefix tree.

function LocationsPage() {
  const { canDo } = useMe()
  const canAdd = canDo("location", "add")
  const { humanIds } = useMe()
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<Location | null>(null)

  const query = useQuery({
    queryKey: ["locations", q],
    queryFn: () =>
      api<Paginated<Location>>(
        `/api/locations/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })

  const allRows = useMemo(() => query.data?.results ?? [], [query.data])
  const onDelete = useCallback((l: Location) => setDeleting(l), [])
  const columns = useMemo<ColumnDef<Location>[]>(
    () => [
      ...(humanIds ? [numidColumn<Location>({ get: (r) => r.numid })] : []),
      {
        id: "name",
        accessorKey: "name",
        header: ({ column }) => <SortHeader column={column} label="Name" />,
        cell: ({ row }) => {
          const depth =
            (row.original as Location & { _depth?: number })._depth ?? 0
          return (
            <div className="flex items-center gap-0.5">
              {Array.from({ length: depth }, (_, i) => (
                <CornerDownRight
                  key={i}
                  aria-hidden
                  className="h-3 w-3 shrink-0 text-muted-foreground/40"
                />
              ))}
              {(row.original.color || row.original.icon) && (
                <TileBadge
                  color={row.original.color}
                  icon={row.original.icon}
                  className="mr-1.5 h-4 w-4"
                />
              )}
              <Link
                to="/locations/$id"
                params={{ id: row.original.id }}
                className="link font-medium"
              >
                {row.original.name}
              </Link>
            </div>
          )
        },
      },
      siteColumn<Location>({ get: (l) => l.site }),
      {
        id: "parent",
        accessorFn: (l) => l.parent?.name ?? "",
        header: "Parent",
        cell: ({ row }) => (
          <LocationCell location={row.original.parent} className="text-xs" />
        ),
      },
      {
        id: "status",
        accessorFn: (r) => r.status?.name ?? "",
        header: "Status",
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
        meta: {
          facet: {
            kind: "enum",
            label: "Status",
            get: (r: Location) => r.status?.id ?? "__none__",
            formatValue: (_v, sample) => ({
              label: sample.status?.name ?? "No status",
              color: sample.status?.color,
              textColor: sample.status?.text_color,
            }),
          },
        },
      },
      {
        id: "children",
        accessorKey: "child_count",
        header: ({ column }) => (
          <SortHeader column={column} label="Sub-locations" />
        ),
        cell: ({ row }) => (
          <span className="num text-xs">{row.original.child_count}</span>
        ),
      },
      {
        id: "actions",
        enableHiding: false,
        cell: ({ row }) => (
          <RowActions
            editTo="/locations/$id/edit"
            editParams={{ id: row.original.id }}
            onDelete={() => onDelete(row.original)}
          />
        ),
      },
    ],
    [onDelete, humanIds]
  )

  // Rail derives from the columns' facet metadata (Status, Site) - filter
  // first, then nest, so children of a hidden parent surface at the root
  // instead of dangling indented under nothing.
  const { rail, filteredRows, snapshot, restore, activeCount } =
    useTableFilters(columns, allRows)
  const rows = useMemo(() => nestByParent(filteredRows), [filteredRows])

  return (
    <ListPageShell
      title="Locations"
      count={query.data ? rows.length : undefined}
      rail={rail}
      savedViews={{
        objectType: "location",
        filters: { snapshot, restore, activeCount },
      }}
      search={{ value: q, onChange: setQ, placeholder: "Filter locations…" }}
      actions={
        <>
          <TableActions ioType="location" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/locations/new">Add location</Link>
            </Button>
          )}
        </>
      }
      query={query}
    >
      <DataTable
        data={rows}
        columns={columns}
        flexColumn="name"
        tableId="locations"
      />
      <LocationDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}
