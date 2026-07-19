import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type Paginated, type Zone } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader, selectionColumn } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { ColorBadge } from "@/components/cells/color-badge"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { LocalityBadge } from "@/components/locality-badge"
import {
  FilterRail,
  FacetGroup,
  toggleInSet,
  type FacetOption,
} from "@/components/filter-rail"
import { ZoneDeleteDialog } from "@/components/zone-delete-dialog"
import { RowActions } from "@/components/row-actions"
import { useMe, objCan } from "@/lib/use-me"

export const Route = createFileRoute("/zones/")({ component: ZonesPage })

const scopeOf = (z: Zone) => (z.owning_site ? "local" : "global")

function ZonesPage() {
  const { canDo } = useMe()
  const canAdd = canDo("zone", "add")
  const canEdit = canDo("zone", "change")
  const canDelete = canDo("zone", "delete")
  const [q, setQ] = useState("")
  const [scopeFilter, setScopeFilter] = useState<Set<string>>(new Set())
  const [deleting, setDeleting] = useState<Zone | null>(null)

  const query = useQuery({
    queryKey: ["zones", q],
    queryFn: () =>
      api<Paginated<Zone>>(
        `/api/zones/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })
  const allRows = query.data?.results ?? []

  const rows = useMemo(
    () =>
      allRows.filter(
        (z) => scopeFilter.size === 0 || scopeFilter.has(scopeOf(z))
      ),
    [allRows, scopeFilter]
  )

  const facets = useMemo(() => {
    const c: Record<string, number> = {}
    for (const z of allRows) c[scopeOf(z)] = (c[scopeOf(z)] ?? 0) + 1
    return [
      { value: "global", label: "Global", count: c["global"] ?? 0 },
      { value: "local", label: "Local", count: c["local"] ?? 0 },
    ].filter((o) => o.count) as FacetOption[]
  }, [allRows])

  const handleDelete = useCallback((z: Zone) => setDeleting(z), [])
  const columns = useMemo<ColumnDef<Zone>[]>(
    () => buildColumns({ onDelete: handleDelete, canEdit, canDelete }),
    [handleDelete, canEdit, canDelete]
  )

  return (
    <ListPageShell
      title="Zones"
      count={query.data ? rows.length : undefined}
      rail={
        <FilterRail>
          <FacetGroup
            label="Scope"
            options={facets}
            selected={scopeFilter}
            onToggle={(v) => toggleInSet(scopeFilter, v, setScopeFilter)}
          />
        </FilterRail>
      }
      search={{ value: q, onChange: setQ, placeholder: "Filter…" }}
      actions={
        <>
          <TableActions ioType="zone" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/zones/new">Add zone</Link>
            </Button>
          )}
        </>
      }
      query={query}
    >
      <DataTable
        data={rows}
        columns={columns}
        flexColumn="description"
        tableId="zones"
      />
      <ZoneDeleteDialog
        zone={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}

function buildColumns({
  onDelete,
  canEdit,
  canDelete,
}: {
  onDelete: (z: Zone) => void
  canEdit: boolean
  canDelete: boolean
}): ColumnDef<Zone>[] {
  return [
    selectionColumn<Zone>(),
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <Link
          to="/zones/$id"
          params={{ id: row.original.id }}
          className="hover:opacity-90"
        >
          <ColorBadge
            name={row.original.name}
            color={row.original.color || undefined}
          />
        </Link>
      ),
    },
    {
      id: "slug",
      accessorKey: "slug",
      header: "Slug",
      cell: ({ row }) => (
        <span className="font-mono text-xs">{row.original.slug}</span>
      ),
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
      id: "usage",
      accessorKey: "usage_count",
      header: ({ column }) => <SortHeader column={column} label="VLANs" />,
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.usage_count}</span>
      ),
    },
    {
      id: "scope",
      accessorFn: (z) => z.owning_site?.name ?? "",
      header: "Scope",
      cell: ({ row }) => (
        <LocalityBadge owningSite={row.original.owning_site} />
      ),
    },
    timeAgoColumn<Zone>({
      id: "created",
      header: "Created",
      get: (r) => r.created_at,
      align: "right",
    }),
    {
      id: "actions",
      enableHiding: false,
      cell: ({ row }) => (
        <RowActions
          editTo={
            objCan(row.original, "change", canEdit)
              ? "/zones/$id/edit"
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
