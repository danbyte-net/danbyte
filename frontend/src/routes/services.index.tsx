import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"
import { toast } from "sonner"

import { api, type Paginated, type Service } from "@/lib/api"
import { DataTable, SortHeader, selectionColumn } from "@/components/data-table"
import { numidColumn } from "@/components/cells/numid"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { ListPageShell } from "@/components/list-page-shell"
import { useTableFilters } from "@/components/table-filters"
import { RowActions } from "@/components/row-actions"
import { useMe } from "@/lib/use-me"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { apiErrorToast } from "@/lib/api-toast"

export const Route = createFileRoute("/services/")({ component: ServicesPage })

function ServicesPage() {
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<Service | null>(null)
  const { canDo, humanIds } = useMe()
  const canDelete = canDo("service", "delete")

  const query = useQuery({
    queryKey: ["services-list", q],
    queryFn: () =>
      api<Paginated<Service>>(
        `/api/services/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })

  const handleDelete = useCallback((s: Service) => setDeleting(s), [])

  const columns = useMemo<ColumnDef<Service>[]>(
    () => buildColumns({ onDelete: handleDelete, canDelete, humanIds }),
    [handleDelete, canDelete, humanIds]
  )

  const allRows = query.data?.results ?? []
  const { rail, filteredRows } = useTableFilters(columns, allRows)

  return (
    <ListPageShell
      title="Services"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter by name, description…",
      }}
      actions={<TableActions ioType="service" />}
      query={query}
    >
      <DataTable
        data={filteredRows}
        columns={columns}
        flexColumn="description"
        tableId="services"
      />
      <ServiceDeleteDialog
        service={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}

interface ColumnOpts {
  onDelete: (s: Service) => void
  canDelete: boolean
  humanIds: boolean
}

function buildColumns({
  onDelete,
  canDelete,
  humanIds,
}: ColumnOpts): ColumnDef<Service>[] {
  return [
    selectionColumn<Service>(),
    ...(humanIds ? [numidColumn<Service>({ get: (r) => r.numid })] : []),
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <Link
          to="/services/$id"
          params={{ id: row.original.id }}
          className="font-medium hover:underline"
        >
          {row.original.name}
        </Link>
      ),
    },
    {
      id: "ports",
      header: "Protocol / Ports",
      cell: ({ row }) => (
        <span className="font-mono text-xs">
          {row.original.protocol.toUpperCase()} {row.original.ports.join(", ")}
        </span>
      ),
      meta: {
        facet: {
          kind: "enum",
          label: "Protocol",
          get: (r: Service) => r.protocol_display,
        },
      },
    },
    {
      id: "parent",
      header: ({ column }) => <SortHeader column={column} label="Parent" />,
      accessorFn: (r) => r.device?.name ?? r.virtual_machine?.name ?? "",
      cell: ({ row }) => {
        const s = row.original
        if (s.device)
          return (
            <Link
              to="/devices/$id"
              params={{ id: s.device.id }}
              className="text-xs text-primary hover:underline"
            >
              {s.device.name}
            </Link>
          )
        if (s.virtual_machine)
          return (
            <Link
              to="/virtual-machines/$id"
              params={{ id: s.virtual_machine.id }}
              className="text-xs text-primary hover:underline"
            >
              {s.virtual_machine.name}
            </Link>
          )
        return <span className="text-muted-foreground">—</span>
      },
    },
    {
      id: "ip",
      header: "IP",
      cell: ({ row }) =>
        row.original.ip_address ? (
          <Link
            to="/ips/$id"
            params={{ id: row.original.ip_address.id }}
            className="font-mono text-xs text-primary hover:underline"
          >
            {row.original.ip_address.ip_address}
          </Link>
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
    timeAgoColumn<Service>({
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
          onDelete={canDelete ? () => onDelete(row.original) : undefined}
        />
      ),
    },
  ]
}

function ServiceDeleteDialog({
  service,
  onOpenChange,
}: {
  service: Service | null
  onOpenChange: (open: boolean) => void
}) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () =>
      api<void>(`/api/services/${service!.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Deleted ${service!.name}`)
      onOpenChange(false)
      qc.invalidateQueries({ queryKey: ["services-list"] })
    },
    onError: (err) => apiErrorToast(err),
  })
  return (
    <AlertDialog open={!!service} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {service?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            This action can&apos;t be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={m.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="text-destructive-foreground bg-destructive hover:bg-destructive/90"
            disabled={m.isPending}
            onClick={(e) => {
              e.preventDefault()
              m.mutate()
            }}
          >
            {m.isPending ? "Deleting…" : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
