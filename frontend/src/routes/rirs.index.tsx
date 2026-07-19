import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type Paginated, type RIR } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader, selectionColumn } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { numidColumn } from "@/components/cells/numid"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { RirDeleteDialog } from "@/components/rir-delete-dialog"
import { RowActions } from "@/components/row-actions"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/rirs/")({ component: RirsPage })

function RirsPage() {
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<RIR | null>(null)
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("rir", "add")
  const canEdit = canDo("rir", "change")
  const canDelete = canDo("rir", "delete")

  const query = useQuery({
    queryKey: ["rirs", q],
    queryFn: () =>
      api<Paginated<RIR>>(
        `/api/rirs/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })
  const rows = query.data?.results ?? []

  const handleDelete = useCallback((r: RIR) => setDeleting(r), [])
  const columns = useMemo<ColumnDef<RIR>[]>(
    () =>
      buildColumns({ onDelete: handleDelete, canEdit, canDelete, humanIds }),
    [handleDelete, canEdit, canDelete, humanIds]
  )

  return (
    <ListPageShell
      title="RIRs"
      count={query.data ? rows.length : undefined}
      search={{ value: q, onChange: setQ, placeholder: "Filter…" }}
      actions={
        <>
          <TableActions ioType="rir" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/rirs/new">Add RIR</Link>
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
        tableId="rirs"
      />
      <RirDeleteDialog
        rir={deleting}
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
  onDelete: (r: RIR) => void
  canEdit: boolean
  canDelete: boolean
  humanIds: boolean
}): ColumnDef<RIR>[] {
  return [
    selectionColumn<RIR>(),
    ...(humanIds ? [numidColumn<RIR>({ get: (r) => r.numid })] : []),
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <Link
          to="/rirs/$id"
          params={{ id: row.original.id }}
          className="font-medium hover:underline"
        >
          {row.original.name}
        </Link>
      ),
    },
    {
      id: "scope",
      accessorKey: "is_private",
      header: "Scope",
      cell: ({ row }) =>
        row.original.is_private ? (
          <Badge variant="secondary">Private</Badge>
        ) : (
          <Badge variant="success">Public</Badge>
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
      id: "aggregates",
      accessorKey: "aggregate_count",
      header: ({ column }) => <SortHeader column={column} label="Aggregates" />,
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.aggregate_count}</span>
      ),
    },
    timeAgoColumn<RIR>({
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
          editTo={canEdit ? "/rirs/$id/edit" : undefined}
          editParams={{ id: row.original.id }}
          onDelete={canDelete ? () => onDelete(row.original) : undefined}
        />
      ),
    },
  ]
}
