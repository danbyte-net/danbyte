import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type Provider, type Paginated } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader } from "@/components/data-table"
import { tagsColumn } from "@/components/cells/tag-list"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { numidColumn } from "@/components/cells/numid"
import { useTableFilters } from "@/components/table-filters"
import { ListPageShell } from "@/components/list-page-shell"
import { RowActions } from "@/components/row-actions"
import { useMe } from "@/lib/use-me"
import { ProviderDeleteDialog } from "@/components/provider-delete-dialog"

export const Route = createFileRoute("/providers/")({
  component: ProvidersPage,
})

function ProvidersPage() {
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("provider", "add")
  const canEdit = canDo("provider", "change")
  const canDelete = canDo("provider", "delete")
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<Provider | null>(null)

  const query = useQuery({
    queryKey: ["providers", q],
    queryFn: () =>
      api<Paginated<Provider>>(
        `/api/providers/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })

  const rows = query.data?.results ?? []
  const onDelete = useCallback((p: Provider) => setDeleting(p), [])
  const columns = useMemo<ColumnDef<Provider>[]>(
    () => [
      ...(humanIds ? [numidColumn<Provider>({ get: (r) => r.numid })] : []),
      {
        id: "name",
        accessorKey: "name",
        header: ({ column }) => <SortHeader column={column} label="Name" />,
        cell: ({ row }) => (
          <Link
            to="/providers/$id/edit"
            params={{ id: row.original.id }}
            className="font-medium hover:underline"
          >
            {row.original.name}
          </Link>
        ),
      },
      {
        id: "account",
        accessorKey: "account",
        header: "Account",
        cell: ({ row }) =>
          row.original.account ? (
            <span className="font-mono text-xs">{row.original.account}</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "noc_email",
        accessorKey: "noc_email",
        header: "NOC email",
        cell: ({ row }) =>
          row.original.noc_email ? (
            <a
              href={`mailto:${row.original.noc_email}`}
              className="font-mono text-xs text-primary hover:underline"
            >
              {row.original.noc_email}
            </a>
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
        meta: {
          facet: {
            kind: "enum",
            label: "Circuits",
            get: (r: Provider) => (r.circuit_count > 0 ? "in_use" : "unused"),
            formatValue: (v) => ({
              label: v === "in_use" ? "In use" : "Unused",
            }),
          },
        },
      },
      tagsColumn<Provider>({ getTags: (r) => r.tags }),
      timeAgoColumn<Provider>({
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
            editTo={canEdit ? "/providers/$id/edit" : undefined}
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
      title="Providers"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      search={{ value: q, onChange: setQ, placeholder: "Filter providers…" }}
      actions={
        <>
          <TableActions ioType="provider" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/providers/new">Add provider</Link>
            </Button>
          )}
        </>
      }
      query={query}
    >
      <DataTable
        data={filteredRows}
        columns={columns}
        flexColumn="noc_email"
        tableId="providers"
      />
      <ProviderDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}
