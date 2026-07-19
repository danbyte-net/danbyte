import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type VirtualMachine, type Paginated } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader, selectionColumn } from "@/components/data-table"
import { numidColumn } from "@/components/cells/numid"
import { tagsColumn } from "@/components/cells/tag-list"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { ColorBadge } from "@/components/cells/color-badge"
import { SiteCell } from "@/components/cells/site-cell"
import { PlatformCell } from "@/components/cells/platform-cell"
import { ListPageShell } from "@/components/list-page-shell"
import { useTableFilters } from "@/components/table-filters"
import { VmDeleteDialog } from "@/components/vm-delete-dialog"
import { StatusBadge } from "@/components/status-badge"
import { RowActions } from "@/components/row-actions"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/virtual-machines/")({
  component: VirtualMachinesPage,
})

/** Memory in MB → "x GB" when an even multiple of 1024, else "x MB". */
function formatMemory(mb: number): string {
  if (mb >= 1024 && mb % 1024 === 0) return `${mb / 1024} GB`
  return `${mb} MB`
}

function VirtualMachinesPage() {
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("virtualmachine", "add")
  const canEdit = canDo("virtualmachine", "change")
  const canDelete = canDo("virtualmachine", "delete")
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<VirtualMachine | null>(null)

  const query = useQuery({
    queryKey: ["virtual-machines", q],
    queryFn: () =>
      api<Paginated<VirtualMachine>>(
        `/api/virtual-machines/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })

  const handleDelete = useCallback((vm: VirtualMachine) => setDeleting(vm), [])

  const columns = useMemo<ColumnDef<VirtualMachine>[]>(
    () =>
      buildColumns({ onDelete: handleDelete, canEdit, canDelete, humanIds }),
    [handleDelete, canEdit, canDelete, humanIds]
  )

  const allRows = query.data?.results ?? []
  const { rail, filteredRows } = useTableFilters(columns, allRows)

  return (
    <ListPageShell
      title="Virtual machines"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter by name, description…",
      }}
      actions={
        <>
          <TableActions ioType="virtualmachine" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/virtual-machines/new">Add VM</Link>
            </Button>
          )}
        </>
      }
      query={query}
    >
      <DataTable
        data={filteredRows}
        columns={columns}
        flexColumn="primary_ip"
        tableId="virtual-machines"
      />
      <VmDeleteDialog
        vm={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}

interface ColumnOpts {
  onDelete: (vm: VirtualMachine) => void
  canEdit: boolean
  canDelete: boolean
  humanIds: boolean
}

function buildColumns({
  onDelete,
  canEdit,
  canDelete,
  humanIds,
}: ColumnOpts): ColumnDef<VirtualMachine>[] {
  return [
    selectionColumn<VirtualMachine>(),
    ...(humanIds ? [numidColumn<VirtualMachine>({ get: (r) => r.numid })] : []),
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <Link
          to="/virtual-machines/$id"
          params={{ id: row.original.id }}
          className="font-medium hover:underline"
        >
          {row.original.name}
        </Link>
      ),
    },
    {
      id: "cluster",
      header: ({ column }) => <SortHeader column={column} label="Cluster" />,
      accessorFn: (r) => r.cluster.name,
      cell: ({ row }) => (
        <Link
          to="/clusters/$id"
          params={{ id: row.original.cluster.id }}
          className="text-xs text-primary hover:underline"
        >
          {row.original.cluster.name}
        </Link>
      ),
      meta: {
        facet: {
          kind: "enum",
          label: "Cluster",
          get: (r: VirtualMachine) => r.cluster.name,
        },
      },
    },
    {
      id: "status",
      accessorFn: (r) => r.status?.name ?? "",
      header: ({ column }) => <SortHeader column={column} label="Status" />,
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
      meta: {
        facet: {
          kind: "enum",
          label: "Status",
          get: (r: VirtualMachine) => r.status?.id ?? "__none__",
          formatValue: (_v, r) => ({
            label: r.status?.name ?? "No status",
            color: r.status?.color,
          }),
        },
      },
    },
    {
      id: "vcpus",
      accessorKey: "vcpus",
      header: ({ column }) => <SortHeader column={column} label="vCPUs" />,
      cell: ({ row }) =>
        row.original.vcpus != null ? (
          <span className="num text-xs">{row.original.vcpus}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "memory",
      accessorKey: "memory_mb",
      header: ({ column }) => <SortHeader column={column} label="Memory" />,
      cell: ({ row }) =>
        row.original.memory_mb != null ? (
          <span className="num text-xs">
            {formatMemory(row.original.memory_mb)}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "disk",
      accessorKey: "disk_gb",
      header: ({ column }) => <SortHeader column={column} label="Disk" />,
      cell: ({ row }) =>
        row.original.disk_gb != null ? (
          <span className="num text-xs">{row.original.disk_gb} GB</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "primary_ip",
      header: "Primary IP",
      accessorFn: (r) => r.primary_ip?.ip_address ?? "",
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
      id: "site",
      header: ({ column }) => <SortHeader column={column} label="Site" />,
      accessorFn: (r) => r.site?.name ?? "",
      cell: ({ row }) => (
        <SiteCell site={row.original.site} className="text-xs" />
      ),
      meta: {
        facet: {
          kind: "enum",
          label: "Site",
          get: (r: VirtualMachine) => r.site?.name ?? "—",
        },
      },
    },
    {
      id: "role",
      header: ({ column }) => <SortHeader column={column} label="Role" />,
      accessorFn: (r) => r.role?.name ?? "",
      cell: ({ row }) =>
        row.original.role ? (
          <ColorBadge
            name={row.original.role.name}
            color={row.original.role.color || undefined}
          />
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
      meta: {
        facet: {
          kind: "enum",
          label: "Role",
          get: (r: VirtualMachine) => r.role?.id ?? "__none__",
          formatValue: (_v, r) => ({
            label: r.role?.name ?? "No role",
            color: r.role?.color,
          }),
        },
      },
    },
    {
      id: "platform",
      header: ({ column }) => <SortHeader column={column} label="Platform" />,
      accessorFn: (r) => r.platform?.name ?? "",
      cell: ({ row }) => (
        <PlatformCell platform={row.original.platform} className="text-xs" />
      ),
      meta: {
        facet: {
          kind: "enum",
          label: "Platform",
          get: (r: VirtualMachine) => r.platform?.id ?? "__none__",
          formatValue: (_v, r) => ({
            label: r.platform?.name ?? "No platform",
          }),
        },
      },
    },
    tagsColumn<VirtualMachine>({
      getTags: (r) => r.tags,
    }),
    timeAgoColumn<VirtualMachine>({
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
          editTo={canEdit ? "/virtual-machines/$id/edit" : undefined}
          editParams={{ id: row.original.id }}
          onDelete={canDelete ? () => onDelete(row.original) : undefined}
        />
      ),
    },
  ]
}
