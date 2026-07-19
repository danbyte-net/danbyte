import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type IPSecProfile, type Paginated } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader, selectionColumn } from "@/components/data-table"
import { useTableFilters } from "@/components/table-filters"
import { ListPageShell } from "@/components/list-page-shell"
import { numidColumn } from "@/components/cells/numid"
import { RowActions } from "@/components/row-actions"
import { IPSecProfileDeleteDialog } from "@/components/ipsec-profile-delete-dialog"
import { IPSecProfileBulkBar } from "@/components/ipsec-profile-bulk-bar"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/ipsec-profiles/")({
  component: IPSecProfilesPage,
})

function IPSecProfilesPage() {
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<IPSecProfile | null>(null)
  const [selectedRows, setSelectedRows] = useState<IPSecProfile[]>([])
  const { humanIds } = useMe()

  const query = useQuery({
    queryKey: ["ipsec-profiles"],
    queryFn: () => api<Paginated<IPSecProfile>>("/api/ipsec-profiles/"),
  })

  const allRows = query.data?.results ?? []
  const rows = useMemo(() => {
    const n = q.trim().toLowerCase()
    if (!n) return allRows
    return allRows.filter((p) => p.name.toLowerCase().includes(n))
  }, [allRows, q])

  const onDelete = useCallback((p: IPSecProfile) => setDeleting(p), [])
  const columns = useMemo<ColumnDef<IPSecProfile>[]>(
    () => buildColumns({ onDelete, humanIds }),
    [onDelete, humanIds]
  )

  const { rail, filteredRows } = useTableFilters(columns, rows)

  return (
    <ListPageShell
      title="IPSec profiles"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      search={{ value: q, onChange: setQ, placeholder: "Filter profiles…" }}
      actions={
        <>
          <TableActions ioType="ipsecprofile" />
          <Button size="sm" asChild>
            <Link to="/ipsec-profiles/new">Add profile</Link>
          </Button>
        </>
      }
      query={query}
    >
      <DataTable
        data={filteredRows}
        columns={columns}
        onSelectedRowsChange={setSelectedRows}
        flexColumn="description"
        tableId="ipsec-profiles"
      />
      <IPSecProfileDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
      <IPSecProfileBulkBar
        selected={selectedRows}
        onCleared={() => setSelectedRows([])}
      />
    </ListPageShell>
  )
}

function buildColumns({
  onDelete,
  humanIds,
}: {
  onDelete: (p: IPSecProfile) => void
  humanIds: boolean
}): ColumnDef<IPSecProfile>[] {
  return [
    selectionColumn<IPSecProfile>(),
    ...(humanIds ? [numidColumn<IPSecProfile>({ get: (r) => r.numid })] : []),
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <Link
          to="/ipsec-profiles/$id/edit"
          params={{ id: row.original.id }}
          className="font-medium hover:underline"
        >
          {row.original.name}
        </Link>
      ),
    },
    {
      id: "ike",
      accessorKey: "ike_version",
      header: "IKE",
      cell: ({ row }) => (
        <span className="text-xs">{row.original.ike_version_display}</span>
      ),
      meta: {
        facet: {
          kind: "enum",
          label: "IKE version",
          get: (r: IPSecProfile) => String(r.ike_version),
          formatValue: (_v, sample) => ({ label: sample.ike_version_display }),
        },
      },
    },
    {
      id: "encryption",
      accessorKey: "encryption",
      header: "Encryption",
      cell: ({ row }) => (
        <span className="font-mono text-[11px] text-muted-foreground">
          {row.original.encryption_display}
        </span>
      ),
      meta: {
        facet: {
          kind: "enum",
          label: "Encryption",
          get: (r: IPSecProfile) => r.encryption,
          formatValue: (_v, sample) => ({ label: sample.encryption_display }),
        },
      },
    },
    {
      id: "auth",
      accessorKey: "authentication",
      header: "Auth",
      cell: ({ row }) => (
        <span className="font-mono text-[11px] text-muted-foreground">
          {row.original.authentication_display}
        </span>
      ),
      meta: {
        facet: {
          kind: "enum",
          label: "Authentication",
          get: (r: IPSecProfile) => r.authentication,
          formatValue: (_v, sample) => ({
            label: sample.authentication_display,
          }),
        },
      },
    },
    {
      id: "dh",
      header: "DH / PFS",
      cell: ({ row }) => (
        <span className="num text-xs">
          {row.original.dh_group}
          {row.original.pfs_group != null && (
            <span className="text-muted-foreground">
              {" "}
              / {row.original.pfs_group}
            </span>
          )}
        </span>
      ),
    },
    {
      id: "tunnels",
      accessorKey: "tunnel_count",
      header: ({ column }) => <SortHeader column={column} label="Tunnels" />,
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.tunnel_count}</span>
      ),
      meta: {
        facet: {
          kind: "enum",
          label: "Usage",
          get: (r: IPSecProfile) => (r.tunnel_count > 0 ? "in_use" : "unused"),
          formatValue: (v) => ({
            label: v === "in_use" ? "In use" : "Unused",
          }),
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
    {
      id: "actions",
      enableHiding: false,
      cell: ({ row }) => (
        <RowActions
          editTo="/ipsec-profiles/$id/edit"
          editParams={{ id: row.original.id }}
          onDelete={() => onDelete(row.original)}
        />
      ),
    },
  ]
}
