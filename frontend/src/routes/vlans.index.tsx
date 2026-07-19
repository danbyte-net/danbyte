import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type Paginated, type VLAN } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader, selectionColumn } from "@/components/data-table"
import { numidColumn } from "@/components/cells/numid"
import { ColorBadge } from "@/components/cells/color-badge"
import { tagsColumn } from "@/components/cells/tag-list"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { SiteCell } from "@/components/cells/site-cell"
import { useTableFilters } from "@/components/table-filters"
import { ListPageShell } from "@/components/list-page-shell"
import { VlanDeleteDialog } from "@/components/vlan-delete-dialog"
import { VlanBulkBar } from "@/components/vlan-bulk-bar"
import { ViolationBadge } from "@/components/compliance/violation-badge"
import { RowActions } from "@/components/row-actions"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/vlans/")({ component: VlansPage })

function VlansPage() {
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("vlan", "add")
  const canEdit = canDo("vlan", "change")
  const canDelete = canDo("vlan", "delete")
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<VLAN | null>(null)
  const [selectedRows, setSelectedRows] = useState<VLAN[]>([])

  const query = useQuery({
    queryKey: ["vlans", q],
    queryFn: () =>
      api<Paginated<VLAN>>(
        `/api/vlans/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })

  const handleDelete = useCallback((v: VLAN) => setDeleting(v), [])

  const columns = useMemo<ColumnDef<VLAN>[]>(
    () =>
      buildColumns({ onDelete: handleDelete, canEdit, canDelete, humanIds }),
    [handleDelete, canEdit, canDelete, humanIds]
  )

  const allRows = query.data?.results ?? []
  const { rail, filteredRows } = useTableFilters(columns, allRows)

  return (
    <ListPageShell
      title="VLANs"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter by ID, name, description…",
      }}
      actions={
        <>
          <TableActions ioType="vlan" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/vlans/new" search={{ vlan_id: undefined }}>
                Add VLAN
              </Link>
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
        tableId="vlans"
      />
      <VlanDeleteDialog
        vlan={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
      <VlanBulkBar
        selected={selectedRows}
        onCleared={() => setSelectedRows([])}
      />
    </ListPageShell>
  )
}

interface ColumnOpts {
  onDelete: (v: VLAN) => void
  canEdit: boolean
  canDelete: boolean
  humanIds: boolean
}

function buildColumns({
  onDelete,
  canEdit,
  canDelete,
  humanIds,
}: ColumnOpts): ColumnDef<VLAN>[] {
  return [
    selectionColumn<VLAN>(),
    ...(humanIds ? [numidColumn<VLAN>({ get: (r) => r.numid })] : []),
    {
      id: "vlan_id",
      accessorKey: "vlan_id",
      header: ({ column }) => <SortHeader column={column} label="VLAN" />,
      cell: ({ row }) => (
        <Link
          to="/vlans/$id"
          params={{ id: row.original.id }}
          className="num font-mono text-xs font-medium hover:underline"
        >
          {row.original.vlan_id}
        </Link>
      ),
      meta: {
        facet: {
          kind: "range",
          label: "VLAN ID",
          get: (r: VLAN) => r.vlan_id,
          min: 1,
          max: 4094,
          placeholder: { min: "1", max: "4094" },
        },
      },
    },
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-1.5">
          <Link
            to="/vlans/$id"
            params={{ id: row.original.id }}
            className="font-medium hover:underline"
          >
            {row.original.name}
          </Link>
          <ViolationBadge objectId={row.original.id} />
        </span>
      ),
    },
    {
      id: "site",
      accessorFn: (v) => v.site?.name ?? "",
      header: ({ column }) => <SortHeader column={column} label="Site" />,
      cell: ({ row }) => <SiteCell site={row.original.site} />,
      meta: {
        facet: {
          kind: "enum",
          label: "Site",
          get: (r: VLAN) => r.site?.id ?? "__none__",
          formatValue: (_v, sample) => ({
            label: sample.site?.name ?? "No site",
          }),
        },
      },
    },
    {
      id: "zone",
      accessorFn: (v) => v.zone?.name ?? "",
      header: ({ column }) => <SortHeader column={column} label="Zone" />,
      cell: ({ row }) =>
        row.original.zone ? (
          <ColorBadge
            name={row.original.zone.name}
            color={row.original.zone.color || undefined}
          />
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
      meta: {
        facet: {
          kind: "enum",
          label: "Zone",
          get: (r: VLAN) => r.zone?.id ?? "__none__",
          formatValue: (_v, sample) => ({
            label: sample.zone?.name ?? "No zone",
          }),
        },
      },
    },
    {
      id: "prefixes",
      accessorKey: "prefix_count",
      header: ({ column }) => <SortHeader column={column} label="Prefixes" />,
      cell: ({ row }) =>
        row.original.prefix_count > 0 ? (
          <span className="num text-xs">{row.original.prefix_count}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
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
    tagsColumn<VLAN>({ getTags: (r) => r.tags }),
    timeAgoColumn<VLAN>({
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
          editTo={canEdit ? "/vlans/$id/edit" : undefined}
          editParams={{ id: row.original.id }}
          onDelete={canDelete ? () => onDelete(row.original) : undefined}
        />
      ),
    },
  ]
}
