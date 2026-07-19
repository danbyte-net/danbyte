import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type Paginated, type Site } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader, selectionColumn } from "@/components/data-table"
import { numidColumn } from "@/components/cells/numid"
import { tagsColumn } from "@/components/cells/tag-list"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { VrfCell } from "@/components/cells/vrf-cell"
import { ListPageShell } from "@/components/list-page-shell"
import { useTableFilters } from "@/components/table-filters"
import { SiteDeleteDialog } from "@/components/site-delete-dialog"
import { ViolationBadge } from "@/components/compliance/violation-badge"
import { SiteBulkBar } from "@/components/site-bulk-bar"
import { RowActions } from "@/components/row-actions"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/sites/")({ component: SitesPage })

const POLICY_LABEL: Record<Site["gateway_policy"], string> = {
  first: "First IP",
  last: "Last IP",
  none: "None",
}

function SitesPage() {
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<Site | null>(null)
  const [selectedRows, setSelectedRows] = useState<Site[]>([])
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("site", "add")
  const canEdit = canDo("site", "change")
  const canDelete = canDo("site", "delete")

  const query = useQuery({
    queryKey: ["sites", q],
    queryFn: () =>
      api<Paginated<Site>>(
        `/api/sites/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })

  const handleDelete = useCallback((s: Site) => setDeleting(s), [])

  // Columns declare their own filterability via meta.facet.
  const columns = useMemo<ColumnDef<Site>[]>(
    () =>
      buildColumns({ onDelete: handleDelete, canEdit, canDelete, humanIds }),
    [handleDelete, canEdit, canDelete, humanIds]
  )

  const allRows = query.data?.results ?? []
  const { rail, filteredRows } = useTableFilters(columns, allRows)

  return (
    <ListPageShell
      title="Sites"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter by name, location, description…",
      }}
      actions={
        <>
          <TableActions ioType="site" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/sites/new">Add Site</Link>
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
        tableId="sites"
      />
      <SiteDeleteDialog
        site={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
      <SiteBulkBar
        selected={selectedRows}
        onCleared={() => setSelectedRows([])}
      />
    </ListPageShell>
  )
}

interface ColumnOpts {
  onDelete: (s: Site) => void
  canEdit: boolean
  canDelete: boolean
  humanIds: boolean
}

function buildColumns({
  onDelete,
  canEdit,
  canDelete,
  humanIds,
}: ColumnOpts): ColumnDef<Site>[] {
  return [
    selectionColumn<Site>(),
    ...(humanIds ? [numidColumn<Site>({ get: (r) => r.numid })] : []),
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Site" />,
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-1.5">
          <Link
            to="/sites/$id"
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
      id: "location",
      accessorKey: "location",
      header: ({ column }) => <SortHeader column={column} label="Location" />,
      cell: ({ row }) =>
        row.original.location ? (
          <span className="text-xs text-muted-foreground">
            {row.original.location}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "gateway_policy",
      accessorKey: "gateway_policy",
      header: ({ column }) => <SortHeader column={column} label="Gateway" />,
      cell: ({ row }) => (
        <span className="text-xs">
          {POLICY_LABEL[row.original.gateway_policy]}
        </span>
      ),
      meta: {
        facet: {
          kind: "enum",
          label: "Gateway policy",
          get: (r: Site) => r.gateway_policy,
          formatValue: (v) => ({
            label: POLICY_LABEL[v as Site["gateway_policy"]] ?? v,
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
      id: "vlans",
      accessorKey: "vlan_count",
      header: ({ column }) => <SortHeader column={column} label="VLANs" />,
      cell: ({ row }) =>
        row.original.vlan_count > 0 ? (
          <span className="num text-xs">{row.original.vlan_count}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "vrfs",
      header: "VRFs",
      enableSorting: false,
      cell: ({ row }) => {
        if (row.original.vrfs.length === 0)
          return <span className="text-muted-foreground">—</span>
        return (
          <div className="flex flex-nowrap items-center gap-1 overflow-hidden">
            {row.original.vrfs.map((v) => (
              <VrfCell key={v.id} vrf={v} />
            ))}
          </div>
        )
      },
      meta: {
        facet: {
          kind: "tags",
          label: "VRFs",
          get: (r: Site) =>
            r.vrfs.map((v) => ({
              slug: v.id,
              name: v.name,
              color: v.color || undefined,
            })),
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
    tagsColumn<Site>({
      getTags: (r) => r.tags,
    }),
    timeAgoColumn<Site>({
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
          editTo={canEdit ? "/sites/$id/edit" : undefined}
          editParams={{ id: row.original.id }}
          onDelete={canDelete ? () => onDelete(row.original) : undefined}
        />
      ),
    },
  ]
}
