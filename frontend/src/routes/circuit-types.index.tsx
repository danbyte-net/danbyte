import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { ColorBadge } from "@/components/cells/color-badge"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type CircuitType, type Paginated } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader } from "@/components/data-table"
import { useTableFilters } from "@/components/table-filters"
import { ListPageShell } from "@/components/list-page-shell"
import { numidColumn } from "@/components/cells/numid"
import { RowActions } from "@/components/row-actions"
import { useMe } from "@/lib/use-me"
import { CircuitTypeDeleteDialog } from "@/components/circuit-type-delete-dialog"

export const Route = createFileRoute("/circuit-types/")({
  component: CircuitTypesPage,
})

function CircuitTypesPage() {
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("circuittype", "add")
  const canEdit = canDo("circuittype", "change")
  const canDelete = canDo("circuittype", "delete")
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<CircuitType | null>(null)

  const query = useQuery({
    queryKey: ["circuit-types"],
    queryFn: () => api<Paginated<CircuitType>>("/api/circuit-types/"),
  })

  const allRows = query.data?.results ?? []
  const rows = useMemo(() => {
    const n = q.trim().toLowerCase()
    if (!n) return allRows
    return allRows.filter(
      (t) =>
        t.name.toLowerCase().includes(n) ||
        t.description.toLowerCase().includes(n)
    )
  }, [allRows, q])

  const onDelete = useCallback((t: CircuitType) => setDeleting(t), [])
  const columns = useMemo<ColumnDef<CircuitType>[]>(
    () => [
      ...(humanIds ? [numidColumn<CircuitType>({ get: (r) => r.numid })] : []),
      {
        id: "name",
        accessorKey: "name",
        header: ({ column }) => <SortHeader column={column} label="Name" />,
        cell: ({ row }) => (
          <Link
            to="/circuit-types/$id/edit"
            params={{ id: row.original.id }}
            className="font-medium hover:underline"
          >
            <ColorBadge
              name={row.original.name}
              color={row.original.color || undefined}
            />
          </Link>
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
            get: (r: CircuitType) => (r.circuit_count > 0 ? "in" : "out"),
            formatValue: (v) => ({
              label: v === "in" ? "In use" : "Unused",
            }),
          },
        },
      },
      {
        id: "actions",
        enableHiding: false,
        cell: ({ row }) => (
          <RowActions
            editTo={canEdit ? "/circuit-types/$id/edit" : undefined}
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
      title="Circuit types"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      search={{ value: q, onChange: setQ, placeholder: "Filter types…" }}
      actions={
        <>
          <TableActions ioType="circuittype" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/circuit-types/new">Add type</Link>
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
        tableId="circuit-types"
      />
      <CircuitTypeDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}
