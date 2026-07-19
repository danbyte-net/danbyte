import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { CornerDownRight } from "lucide-react"
import { useCallback, useMemo, useState } from "react"

import { api, type Location, type Paginated } from "@/lib/api"
import { useMe } from "@/lib/use-me"
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

export const Route = createFileRoute("/locations/")({
  component: LocationsPage,
})

/** A location annotated with its depth in the parent tree (0 = root). */
type NestedLocation = Location & { _depth: number }

// Order depth-first (parents before their children, siblings by name) and
// stamp each row's depth so the Name cell can indent — same tree treatment
// as the prefix list. Orphans (parent filtered out or not loaded) surface
// at the root rather than disappearing.
function nestLocations(rows: Location[]): NestedLocation[] {
  const byParent = new Map<string | null, Location[]>()
  const ids = new Set(rows.map((r) => r.id))
  for (const r of rows) {
    const key = r.parent && ids.has(r.parent.id) ? r.parent.id : null
    const bucket = byParent.get(key)
    if (bucket) bucket.push(r)
    else byParent.set(key, [r])
  }
  for (const bucket of byParent.values())
    bucket.sort((a, b) => a.name.localeCompare(b.name))

  const out: NestedLocation[] = []
  const walk = (parentId: string | null, depth: number) => {
    for (const r of byParent.get(parentId) ?? []) {
      out.push({ ...r, _depth: depth })
      walk(r.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
}

function LocationsPage() {
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
              <Link
                to="/locations/$id"
                params={{ id: row.original.id }}
                className="font-medium hover:underline"
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

  // Rail derives from the columns' facet metadata (Status, Site) — filter
  // first, then nest, so children of a hidden parent surface at the root
  // instead of dangling indented under nothing.
  const { rail, filteredRows } = useTableFilters(columns, allRows)
  const rows = useMemo(() => nestLocations(filteredRows), [filteredRows])

  return (
    <ListPageShell
      title="Locations"
      count={query.data ? rows.length : undefined}
      rail={rail}
      search={{ value: q, onChange: setQ, placeholder: "Filter locations…" }}
      actions={
        <>
          <TableActions ioType="location" />
          <Button size="sm" asChild>
            <Link to="/locations/new">Add location</Link>
          </Button>
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
