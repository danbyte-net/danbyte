import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type Paginated, type VirtualChassis } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader } from "@/components/data-table"
import { useTableFilters } from "@/components/table-filters"
import { ListPageShell } from "@/components/list-page-shell"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { numidColumn } from "@/components/cells/numid"
import { tagsColumn } from "@/components/cells/tag-list"
import { RowActions } from "@/components/row-actions"
import { VirtualChassisDeleteDialog } from "@/components/virtual-chassis-delete-dialog"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/virtual-chassis/")({
  component: VirtualChassisPage,
})

function VirtualChassisPage() {
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("virtualchassis", "add")
  const canEdit = canDo("virtualchassis", "change")
  const canDelete = canDo("virtualchassis", "delete")
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<VirtualChassis | null>(null)

  const query = useQuery({
    queryKey: ["virtual-chassis", q],
    queryFn: () =>
      api<Paginated<VirtualChassis>>(
        `/api/virtual-chassis/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })

  const rows = query.data?.results ?? []
  const onDelete = useCallback((v: VirtualChassis) => setDeleting(v), [])
  const columns = useMemo<ColumnDef<VirtualChassis>[]>(
    () => [
      ...(humanIds
        ? [numidColumn<VirtualChassis>({ get: (r) => r.numid })]
        : []),
      {
        id: "name",
        accessorKey: "name",
        header: ({ column }) => <SortHeader column={column} label="Name" />,
        cell: ({ row }) => (
          <Link
            to="/virtual-chassis/$id"
            params={{ id: row.original.id }}
            className="font-medium hover:underline"
          >
            {row.original.name}
          </Link>
        ),
      },
      {
        id: "domain",
        accessorKey: "domain",
        header: "Domain",
        cell: ({ row }) =>
          row.original.domain ? (
            <span className="font-mono text-xs">{row.original.domain}</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "master",
        accessorFn: (v) => v.master?.name ?? "",
        header: "Master",
        cell: ({ row }) =>
          row.original.master ? (
            <Link
              to="/devices/$id"
              params={{ id: row.original.master.id }}
              className="font-mono text-xs hover:underline"
            >
              {row.original.master.name}
            </Link>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "members",
        accessorKey: "member_count",
        header: ({ column }) => <SortHeader column={column} label="Members" />,
        cell: ({ row }) => (
          <span className="num text-xs">{row.original.member_count}</span>
        ),
        meta: {
          facet: {
            kind: "enum",
            label: "Members",
            get: (r: VirtualChassis) => (r.member_count > 0 ? "in" : "out"),
            formatValue: (v) => ({
              label: v === "in" ? "Has members" : "Empty",
            }),
          },
        },
      },
      {
        id: "primary_ip",
        accessorFn: (v) => v.primary_ip?.ip_address ?? "",
        header: "Primary IP",
        cell: ({ row }) =>
          row.original.primary_ip ? (
            <Link
              to="/ips/$id"
              params={{ id: row.original.primary_ip.id }}
              className="font-mono text-xs hover:underline"
            >
              {row.original.primary_ip.ip_address}
            </Link>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "oob_ip",
        accessorFn: (v) => v.oob_ip?.ip_address ?? "",
        header: "OOB IP",
        cell: ({ row }) =>
          row.original.oob_ip ? (
            <Link
              to="/ips/$id"
              params={{ id: row.original.oob_ip.id }}
              className="font-mono text-xs hover:underline"
            >
              {row.original.oob_ip.ip_address}
            </Link>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      tagsColumn<VirtualChassis>({ getTags: (r) => r.tags ?? [] }),
      {
        id: "description",
        accessorKey: "description",
        header: "Description",
        cell: ({ row }) => (
          <span className="block whitespace-nowrap text-muted-foreground">
            {row.original.description || "—"}
          </span>
        ),
      },
      timeAgoColumn<VirtualChassis>({
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
            editTo={canEdit ? "/virtual-chassis/$id/edit" : undefined}
            editParams={{ id: row.original.id }}
            onDelete={canDelete ? () => onDelete(row.original) : undefined}
          />
        ),
      },
    ],
    [onDelete, canEdit, canDelete, humanIds]
  )
  const { rail, filteredRows } = useTableFilters(columns, rows)

  return (
    <ListPageShell
      title="Virtual chassis"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      search={{ value: q, onChange: setQ, placeholder: "Filter by name…" }}
      actions={
        <>
          <TableActions ioType="virtualchassis" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/virtual-chassis/new">Add virtual chassis</Link>
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
        tableId="virtual-chassis"
      />
      <VirtualChassisDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}
