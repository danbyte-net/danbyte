import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type Paginated, type Rack } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader, selectionColumn } from "@/components/data-table"
import { ColorBadge } from "@/components/cells/color-badge"
import { numidColumn } from "@/components/cells/numid"
import { tagsColumn } from "@/components/cells/tag-list"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { ListPageShell } from "@/components/list-page-shell"
import { useTableFilters } from "@/components/table-filters"
import { RackDeleteDialog } from "@/components/rack-delete-dialog"
import { StatusBadge } from "@/components/status-badge"
import { RowActions } from "@/components/row-actions"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/racks/")({ component: RacksPage })

function RacksPage() {
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<Rack | null>(null)
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("rack", "add")
  const canEdit = canDo("rack", "change")
  const canDelete = canDo("rack", "delete")

  const query = useQuery({
    queryKey: ["racks", q],
    queryFn: () =>
      api<Paginated<Rack>>(
        `/api/racks/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })

  const handleDelete = useCallback((r: Rack) => setDeleting(r), [])
  const columns = useMemo<ColumnDef<Rack>[]>(
    () =>
      buildColumns({ onDelete: handleDelete, canEdit, canDelete, humanIds }),
    [handleDelete, canEdit, canDelete, humanIds]
  )

  const allRows = query.data?.results ?? []
  const { rail, filteredRows } = useTableFilters(columns, allRows)

  return (
    <ListPageShell
      title="Racks"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter by name, facility ID…",
      }}
      actions={
        <>
          <TableActions ioType="rack" />
          <Button size="sm" variant="outline" asChild>
            <Link to="/racks/elevations">Elevations</Link>
          </Button>
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/racks/new">Add rack</Link>
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
        tableId="racks"
      />
      <RackDeleteDialog
        rack={deleting}
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
  onDelete: (r: Rack) => void
  canEdit: boolean
  canDelete: boolean
  humanIds: boolean
}): ColumnDef<Rack>[] {
  return [
    selectionColumn<Rack>(),
    ...(humanIds ? [numidColumn<Rack>({ get: (r) => r.numid })] : []),
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <Link
          to="/racks/$id"
          params={{ id: row.original.id }}
          className="font-medium hover:underline"
        >
          {row.original.name}
        </Link>
      ),
    },
    {
      id: "site",
      header: ({ column }) => <SortHeader column={column} label="Site" />,
      accessorFn: (r) => r.site.name,
      cell: ({ row }) => (
        <Link
          to="/sites/$id"
          params={{ id: row.original.site.id }}
          className="text-xs text-primary hover:underline"
        >
          {row.original.site.name}
        </Link>
      ),
      meta: {
        facet: {
          kind: "enum",
          label: "Site",
          get: (r: Rack) => r.site.id,
          formatValue: (_v, r) => ({ label: r.site.name }),
        },
      },
    },
    {
      id: "role",
      header: ({ column }) => <SortHeader column={column} label="Role" />,
      accessorFn: (r) => r.role?.name ?? "",
      cell: ({ row }) =>
        row.original.role ? (
          <ColorBadge
            name={row.original.role.name}
            color={row.original.role.color || undefined}
          />
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
      meta: {
        facet: {
          kind: "enum",
          label: "Role",
          get: (r: Rack) => r.role?.id ?? "__none__",
          formatValue: (_v, r) => ({
            label: r.role?.name ?? "No role",
            color: r.role?.color,
          }),
        },
      },
    },
    {
      id: "status",
      accessorFn: (r) => r.status?.name ?? "",
      header: ({ column }) => <SortHeader column={column} label="Status" />,
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
      meta: {
        facet: {
          kind: "enum",
          label: "Status",
          get: (r: Rack) => r.status?.id ?? "__none__",
          formatValue: (_v, r) => ({
            label: r.status?.name ?? "No status",
            color: r.status?.color,
          }),
        },
      },
    },
    {
      id: "height",
      accessorKey: "u_height",
      header: ({ column }) => <SortHeader column={column} label="Height" />,
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.u_height}U</span>
      ),
    },
    {
      id: "devices",
      accessorKey: "device_count",
      header: ({ column }) => <SortHeader column={column} label="Devices" />,
      cell: ({ row }) =>
        row.original.device_count > 0 ? (
          <span className="num text-xs">{row.original.device_count}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "utilisation",
      header: ({ column }) => <SortHeader column={column} label="Used" />,
      accessorFn: (r) => (r.u_height ? r.used_units / r.u_height : 0),
      cell: ({ row }) => <UtilCell rack={row.original} />,
    },
    tagsColumn<Rack>({
      getTags: (r) => r.tags,
    }),
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
    timeAgoColumn<Rack>({
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
          editTo={canEdit ? "/racks/$id/edit" : undefined}
          editParams={{ id: row.original.id }}
          onDelete={canDelete ? () => onDelete(row.original) : undefined}
        />
      ),
    },
  ]
}

function UtilCell({ rack }: { rack: Rack }) {
  const pct = rack.u_height
    ? Math.round((rack.used_units / rack.u_height) * 100)
    : 0
  const tone =
    pct > 95 ? "bg-red-500" : pct > 80 ? "bg-amber-500" : "bg-emerald-500"
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
        <div
          className={tone}
          style={{ width: `${Math.min(100, pct)}%`, height: "100%" }}
        />
      </div>
      <span className="num text-[11px] text-muted-foreground">
        {rack.used_units}/{rack.u_height}
      </span>
    </div>
  )
}
