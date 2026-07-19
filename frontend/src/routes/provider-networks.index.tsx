import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type Paginated, type ProviderNetwork } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader } from "@/components/data-table"
import { tagsColumn } from "@/components/cells/tag-list"
import { useTableFilters } from "@/components/table-filters"
import { ListPageShell } from "@/components/list-page-shell"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { numidColumn } from "@/components/cells/numid"
import { RowActions } from "@/components/row-actions"
import { useMe } from "@/lib/use-me"
import { ProviderNetworkDeleteDialog } from "@/components/provider-network-delete-dialog"

export const Route = createFileRoute("/provider-networks/")({
  component: ProviderNetworksPage,
})

function ProviderNetworksPage() {
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("providernetwork", "add")
  const canEdit = canDo("providernetwork", "change")
  const canDelete = canDo("providernetwork", "delete")
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<ProviderNetwork | null>(null)

  const query = useQuery({
    queryKey: ["provider-networks", q],
    queryFn: () =>
      api<Paginated<ProviderNetwork>>(
        `/api/provider-networks/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })

  const rows = query.data?.results ?? []
  const onDelete = useCallback((n: ProviderNetwork) => setDeleting(n), [])
  const columns = useMemo<ColumnDef<ProviderNetwork>[]>(
    () => [
      ...(humanIds
        ? [numidColumn<ProviderNetwork>({ get: (r) => r.numid })]
        : []),
      {
        id: "name",
        accessorKey: "name",
        header: ({ column }) => <SortHeader column={column} label="Name" />,
        cell: ({ row }) => (
          <Link
            to="/provider-networks/$id/edit"
            params={{ id: row.original.id }}
            className="font-medium hover:underline"
          >
            {row.original.name}
          </Link>
        ),
      },
      {
        id: "provider",
        accessorFn: (n) => n.provider?.name ?? "",
        header: "Provider",
        cell: ({ row }) => (
          <span className="text-xs">{row.original.provider?.name ?? "—"}</span>
        ),
        meta: {
          facet: {
            kind: "enum",
            label: "Provider",
            get: (r: ProviderNetwork) => r.provider?.id ?? "__none__",
            formatValue: (_v, s) => ({ label: s.provider?.name ?? "None" }),
          },
        },
      },
      {
        id: "service_id",
        accessorKey: "service_id",
        header: "Service ID",
        cell: ({ row }) =>
          row.original.service_id ? (
            <span className="font-mono text-xs">{row.original.service_id}</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "circuits",
        accessorKey: "circuit_count",
        header: ({ column }) => <SortHeader column={column} label="Circuits" />,
        cell: ({ row }) => (
          <span className="num text-xs">{row.original.circuit_count}</span>
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
      tagsColumn<ProviderNetwork>({ getTags: (r) => r.tags }),
      timeAgoColumn<ProviderNetwork>({
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
            editTo={canEdit ? "/provider-networks/$id/edit" : undefined}
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
      title="Provider networks"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      search={{ value: q, onChange: setQ, placeholder: "Filter by name…" }}
      actions={
        <>
          <TableActions ioType="providernetwork" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/provider-networks/new">Add provider network</Link>
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
        tableId="provider-networks"
      />
      <ProviderNetworkDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}
