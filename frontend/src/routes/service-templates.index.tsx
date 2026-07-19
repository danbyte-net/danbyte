import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type Paginated, type ServiceTemplate } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader, selectionColumn } from "@/components/data-table"
import { useTableFilters } from "@/components/table-filters"
import { ListPageShell } from "@/components/list-page-shell"
import { numidColumn } from "@/components/cells/numid"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { ServiceTemplateDeleteDialog } from "@/components/service-template-delete-dialog"
import { RowActions } from "@/components/row-actions"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/service-templates/")({
  component: ServiceTemplatesPage,
})

function ServiceTemplatesPage() {
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<ServiceTemplate | null>(null)
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("servicetemplate", "add")
  const canEdit = canDo("servicetemplate", "change")
  const canDelete = canDo("servicetemplate", "delete")

  const query = useQuery({
    queryKey: ["service-templates", q],
    queryFn: () =>
      api<Paginated<ServiceTemplate>>(
        `/api/service-templates/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })
  const rows = query.data?.results ?? []

  const handleDelete = useCallback((t: ServiceTemplate) => setDeleting(t), [])
  const columns = useMemo<ColumnDef<ServiceTemplate>[]>(
    () =>
      buildColumns({ onDelete: handleDelete, canEdit, canDelete, humanIds }),
    [handleDelete, canEdit, canDelete, humanIds]
  )
  const { rail, filteredRows } = useTableFilters(columns, rows)

  return (
    <ListPageShell
      title="Service templates"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      search={{ value: q, onChange: setQ, placeholder: "Filter…" }}
      actions={
        <>
          <TableActions ioType="servicetemplate" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/service-templates/new">Add template</Link>
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
        tableId="service-templates"
      />
      <ServiceTemplateDeleteDialog
        template={deleting}
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
  onDelete: (t: ServiceTemplate) => void
  canEdit: boolean
  canDelete: boolean
  humanIds: boolean
}): ColumnDef<ServiceTemplate>[] {
  return [
    selectionColumn<ServiceTemplate>(),
    ...(humanIds
      ? [numidColumn<ServiceTemplate>({ get: (r) => r.numid })]
      : []),
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <Link
          to="/service-templates/$id"
          params={{ id: row.original.id }}
          className="font-medium hover:underline"
        >
          {row.original.name}
        </Link>
      ),
    },
    {
      id: "protocol",
      accessorKey: "protocol",
      header: ({ column }) => <SortHeader column={column} label="Protocol" />,
      cell: ({ row }) => (
        <Badge variant="secondary">
          {row.original.protocol_display || row.original.protocol.toUpperCase()}
        </Badge>
      ),
      meta: {
        facet: {
          kind: "enum",
          label: "Protocol",
          get: (t: ServiceTemplate) => t.protocol,
          formatValue: (v) => ({ label: String(v).toUpperCase() }),
        },
      },
    },
    {
      id: "ports",
      header: "Ports",
      cell: ({ row }) => (
        <span className="font-mono text-xs">
          {row.original.ports.join(", ") || "—"}
        </span>
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
      id: "services",
      accessorKey: "service_count",
      header: ({ column }) => <SortHeader column={column} label="In use" />,
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.service_count ?? 0}</span>
      ),
      meta: {
        facet: {
          kind: "enum",
          label: "Usage",
          get: (t: ServiceTemplate) =>
            (t.service_count ?? 0) > 0 ? "in" : "out",
          formatValue: (v) => ({
            label: v === "in" ? "In use" : "Unused",
          }),
        },
      },
    },
    timeAgoColumn<ServiceTemplate>({
      id: "updated",
      header: "Updated",
      get: (t) => t.updated_at,
      align: "right",
    }),
    {
      id: "actions",
      enableHiding: false,
      cell: ({ row }) => (
        <RowActions
          editTo={canEdit ? "/service-templates/$id/edit" : undefined}
          editParams={{ id: row.original.id }}
          onDelete={canDelete ? () => onDelete(row.original) : undefined}
        />
      ),
    },
  ]
}
