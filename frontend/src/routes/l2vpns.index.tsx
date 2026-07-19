import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type L2VPN, type Paginated } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader } from "@/components/data-table"
import { tagsColumn } from "@/components/cells/tag-list"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { useTableFilters } from "@/components/table-filters"
import { ListPageShell } from "@/components/list-page-shell"
import { numidColumn } from "@/components/cells/numid"
import { RowActions } from "@/components/row-actions"
import { L2vpnDeleteDialog } from "@/components/l2vpn-delete-dialog"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/l2vpns/")({ component: L2vpnsPage })

/** Import/export route-target names as muted text, or a dash. */
function RtCell({ rts }: { rts: { id: string; name: string }[] }) {
  if (rts.length === 0) return <span className="text-muted-foreground">—</span>
  return (
    <span className="font-mono text-[11px] text-muted-foreground">
      {rts.map((rt) => rt.name).join(", ")}
    </span>
  )
}

function L2vpnsPage() {
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<L2VPN | null>(null)
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("l2vpn", "add")
  const canEdit = canDo("l2vpn", "change")
  const canDelete = canDo("l2vpn", "delete")

  const query = useQuery({
    queryKey: ["l2vpns", q],
    queryFn: () =>
      api<Paginated<L2VPN>>(
        `/api/l2vpns/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })

  const rows = query.data?.results ?? []
  const onDelete = useCallback((v: L2VPN) => setDeleting(v), [])
  const columns = useMemo<ColumnDef<L2VPN>[]>(
    () => [
      ...(humanIds ? [numidColumn<L2VPN>({ get: (r) => r.numid })] : []),
      {
        id: "name",
        accessorKey: "name",
        header: ({ column }) => <SortHeader column={column} label="Name" />,
        cell: ({ row }) => (
          <Link
            to="/l2vpns/$id"
            params={{ id: row.original.id }}
            className="font-medium hover:underline"
          >
            {row.original.name}
          </Link>
        ),
      },
      {
        id: "type",
        accessorKey: "type",
        header: "Type",
        cell: ({ row }) => (
          <Badge variant="secondary">{row.original.type_display}</Badge>
        ),
        meta: {
          facet: {
            kind: "enum",
            label: "Type",
            get: (r: L2VPN) => r.type,
            formatValue: (_v, sample) => ({ label: sample.type_display }),
          },
        },
      },
      {
        id: "identifier",
        accessorKey: "identifier",
        header: ({ column }) => <SortHeader column={column} label="ID" />,
        cell: ({ row }) =>
          row.original.identifier != null ? (
            <span className="num font-mono text-xs">
              {row.original.identifier}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "terminations",
        accessorKey: "termination_count",
        header: ({ column }) => (
          <SortHeader column={column} label="Terminations" />
        ),
        cell: ({ row }) =>
          row.original.termination_count > 0 ? (
            <span className="num text-xs">
              {row.original.termination_count}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "import_targets",
        accessorFn: (r) => r.import_targets.map((t) => t.name).join(", "),
        header: "Import RTs",
        cell: ({ row }) => <RtCell rts={row.original.import_targets} />,
      },
      {
        id: "export_targets",
        accessorFn: (r) => r.export_targets.map((t) => t.name).join(", "),
        header: "Export RTs",
        cell: ({ row }) => <RtCell rts={row.original.export_targets} />,
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
      tagsColumn<L2VPN>({ getTags: (r) => r.tags }),
      timeAgoColumn<L2VPN>({
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
            editTo={canEdit ? "/l2vpns/$id/edit" : undefined}
            editParams={{ id: row.original.id }}
            onDelete={canDelete ? () => onDelete(row.original) : undefined}
          />
        ),
      },
    ],
    [onDelete, humanIds, canEdit, canDelete]
  )

  const { rail, filteredRows } = useTableFilters(columns, rows)

  return (
    <ListPageShell
      title="L2VPNs"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      search={{ value: q, onChange: setQ, placeholder: "Filter L2VPNs…" }}
      actions={
        <>
          <TableActions ioType="l2vpn" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/l2vpns/new">Add L2VPN</Link>
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
        tableId="l2vpns"
      />
      <L2vpnDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}
